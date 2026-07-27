// The uniform resource families, over the service's generic `/v1/<resource>` CRUD.
//
// THE INTERESTING PART OF THIS FILE IS THE WRITE VALIDATION, and it exists because
// of a specific asymmetry: the generic route IGNORES a body key the resource has no
// column for. It does not refuse it. So `create({ nonsense_column: 1 })` answers 201
// with a row that does not contain the field — a write the caller believes happened
// and that silently did not. That is the "accepted and dropped" class in its purest
// form, and the seam requires a refusal instead.
//
// WHERE THE COLUMN LIST COMES FROM, and why it is not written down here: the service
// PUBLISHES it. `GET /v1/openapi.json` is generated from the same
// `SELF_HOSTED_RESOURCES` registry the router dispatches on, and each resource's
// request schema carries `additionalProperties: false` with the exact writable column
// set (src/server/self-hosted/openapi.ts:1628-1631). So this store reads the
// authority rather than copying it. A hand-written column table here would be a
// SECOND source of truth for the same list, going stale silently the first time a
// column is added server-side — which is the failure the seam's own records.ts
// declines to commit for these families.
//
// The document is fetched ONCE per store and cached. If it cannot be read, or does
// not describe a resource this store exposes, that is a FAULT and not a refusal: the
// store cannot keep its promise to reject dropped fields, and pretending otherwise
// would quietly restore the behaviour this validation removes.

import type { ListOptions, ResourceInput, ResourceRow } from "../store/records.js";
import type { Outcome } from "../store/outcome.js";
import type { ResourceRepository } from "../store/repositories.js";
import { asArrayOf, asRecord, envelope } from "./mapping.js";
import { EmailsApiFault, invalidInput, ok, refusalForStatus } from "./outcome.js";
import type { QueryValue, Transport } from "./wire.js";

/** What a resource accepts, read off the service's published contract. */
interface ResourceContract {
  /** Writable column names. */
  columns: Set<string>;
  /** Query parameters the list route accepts as equality filters. */
  filters: Set<string>;
}

/** The generic CRUD surface, also reused by `ProvisioningRepository`. */
export interface ResourceGateway {
  list(opts?: ListOptions & { filters?: Record<string, string> }): Promise<Outcome<ResourceRow[]>>;
  get(id: string): Promise<Outcome<ResourceRow | null>>;
  create(input: ResourceInput): Promise<Outcome<ResourceRow>>;
  update(id: string, patch: ResourceInput): Promise<Outcome<ResourceRow | null>>;
  remove(id: string): Promise<Outcome<boolean>>;
}

/** Paging parameters every generic list route accepts, excluded from the filter check. */
const PAGING_PARAMETERS = new Set(["limit", "offset"]);

function schemaProperties(operation: unknown): string[] | null {
  if (typeof operation !== "object" || operation === null) return null;
  const body = (operation as { requestBody?: unknown }).requestBody;
  if (typeof body !== "object" || body === null) return null;
  const content = (body as { content?: unknown }).content;
  if (typeof content !== "object" || content === null) return null;
  const json = (content as Record<string, unknown>)["application/json"];
  if (typeof json !== "object" || json === null) return null;
  const schema = (json as { schema?: unknown }).schema;
  if (typeof schema !== "object" || schema === null) return null;
  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return null;
  return Object.keys(properties as Record<string, unknown>);
}

function queryParameterNames(operation: unknown): string[] {
  if (typeof operation !== "object" || operation === null) return [];
  const parameters = (operation as { parameters?: unknown }).parameters;
  if (!Array.isArray(parameters)) return [];
  return parameters
    .filter((parameter): parameter is Record<string, unknown> => typeof parameter === "object" && parameter !== null)
    .filter((parameter) => parameter["in"] === "query")
    .map((parameter) => parameter["name"])
    .filter((name): name is string => typeof name === "string");
}

/**
 * Read the published contract for one resource path, once, and remember it.
 *
 * Shared across every family of one store, so a store that touches ten families
 * fetches the document once rather than ten times.
 */
function createContractReader(transport: Transport): (path: string) => Promise<ResourceContract> {
  let document: Promise<Record<string, unknown>> | null = null;
  const contracts = new Map<string, ResourceContract>();

  const fetchDocument = async (): Promise<Record<string, unknown>> => {
    const answer = await transport.request("GET", "/openapi.json");
    if (answer.status !== 200) {
      throw new EmailsApiFault(
        answer.status,
        `the Emails API would not serve its own contract at /v1/openapi.json (${answer.status}); ` +
          "this store cannot tell a writable column from a dropped one without it",
      );
    }
    const paths = asRecord(answer.body, "/v1/openapi.json")["paths"];
    return asRecord(paths, "/v1/openapi.json paths");
  };

  return async (path: string): Promise<ResourceContract> => {
    const cached = contracts.get(path);
    if (cached) return cached;
    document ??= fetchDocument();
    const paths = await document;
    const collection = paths[`/v1/${path}`];
    const columns = schemaProperties(asRecord(collection, `/v1/${path} contract`)["post"]);
    if (columns === null) {
      throw new EmailsApiFault(
        200,
        `the Emails API contract describes no writable columns for /v1/${path}; ` +
          "this store cannot promise to refuse a column the resource does not have",
      );
    }
    const contract: ResourceContract = {
      columns: new Set(columns),
      filters: new Set(queryParameterNames(asRecord(collection, `/v1/${path} contract`)["get"])),
    };
    contracts.set(path, contract);
    return contract;
  };
}

/** The columns a write names that the resource does not have. */
function unknownKeys(input: ResourceInput, allowed: Set<string>): string[] {
  return Object.keys(input).filter((key) => !allowed.has(key));
}

function createGateway(
  transport: Transport,
  path: string,
  contractFor: (path: string) => Promise<ResourceContract>,
): ResourceGateway {
  const what = (operation: string): string => `${path}.${operation}`;

  return {
    async list(opts?: ListOptions & { filters?: Record<string, string> }): Promise<Outcome<ResourceRow[]>> {
      const query: Record<string, QueryValue> = { limit: opts?.limit, offset: opts?.offset };
      if (opts?.filters && Object.keys(opts.filters).length > 0) {
        const contract = await contractFor(path);
        // A filter the route does not accept is IGNORED by the service, which answers
        // with the unfiltered list — a superset presented as a filtered result. Refused
        // for the same reason an unknown write column is.
        const unsupported = Object.keys(opts.filters).filter(
          (key) => !contract.filters.has(key) || PAGING_PARAMETERS.has(key),
        );
        if (unsupported.length > 0) {
          return invalidInput(
            `${what("list")}: /v1/${path} does not filter on ${unsupported.join(", ")}, ` +
              "and answering with the unfiltered list would be a wrong result rather than a refusal",
          );
        }
        for (const [key, value] of Object.entries(opts.filters)) query[key] = value;
      }
      const answer = await transport.request("GET", `/${path}`, { query });
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, what("list"));
      const rows = asArrayOf(envelope(answer.body, "items", what("list")), what("list"));
      return ok(rows.map((row) => asRecord(row, what("list"))));
    },

    async get(id: string): Promise<Outcome<ResourceRow | null>> {
      const answer = await transport.request("GET", `/${path}/${encodeURIComponent(id)}`);
      if (answer.status === 404) return ok(null);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, what("get"));
      // The generic routes answer with a BARE row, not an envelope.
      return ok(asRecord(answer.body, what("get")));
    },

    async create(input: ResourceInput): Promise<Outcome<ResourceRow>> {
      const contract = await contractFor(path);
      const unknown = unknownKeys(input, contract.columns);
      if (unknown.length > 0) {
        return invalidInput(
          `${what("create")}: /v1/${path} has no column ${unknown.join(", ")}, and the write ` +
            "would have been accepted with that field silently dropped",
        );
      }
      const answer = await transport.request("POST", `/${path}`, { body: input });
      if (answer.status !== 201) return refusalForStatus(answer.status, answer.body, what("create"));
      return ok(asRecord(answer.body, what("create")));
    },

    async update(id: string, patch: ResourceInput): Promise<Outcome<ResourceRow | null>> {
      const contract = await contractFor(path);
      const unknown = unknownKeys(patch, contract.columns);
      if (unknown.length > 0) {
        return invalidInput(
          `${what("update")}: /v1/${path} has no column ${unknown.join(", ")}, and the write ` +
            "would have been accepted with that field silently dropped",
        );
      }
      const answer = await transport.request("PATCH", `/${path}/${encodeURIComponent(id)}`, { body: patch });
      if (answer.status === 404) return ok(null);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, what("update"));
      return ok(asRecord(answer.body, what("update")));
    },

    async remove(id: string): Promise<Outcome<boolean>> {
      const answer = await transport.request("DELETE", `/${path}/${encodeURIComponent(id)}`);
      if (answer.status === 404) return ok(false);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, what("remove"));
      return ok(true);
    },
  };
}

/**
 * One gateway per `/v1` resource path, built up front.
 *
 * A gateway IS the `ResourceRepository` surface structurally, so a family is wired by
 * naming its path — but the type below is written out rather than inherited, because
 * every repository on this seam must stand alone (repositories.ts rule 2).
 */
export function createResourceGateways(
  transport: Transport,
  paths: Readonly<Record<string, string>>,
): Record<string, ResourceGateway> {
  const contractFor = createContractReader(transport);
  const gateways: Record<string, ResourceGateway> = {};
  for (const [family, path] of Object.entries(paths)) {
    gateways[family] = createGateway(transport, path, contractFor);
  }
  return gateways;
}

/**
 * Present a gateway as a family repository.
 *
 * Each method is DECLARED here and delegates explicitly. Handing the gateway over
 * directly would type-check, but this is the shape that keeps a method the seam adds
 * a `tsc` error at the assignment instead of a call that resolves to whatever the
 * gateway happens to have.
 */
export function createResourceRepository(gateway: ResourceGateway): ResourceRepository<ResourceRow> {
  return {
    async list(opts?: ListOptions & { filters?: Record<string, string> }): Promise<Outcome<ResourceRow[]>> {
      return gateway.list(opts);
    },
    async get(id: string): Promise<Outcome<ResourceRow | null>> {
      return gateway.get(id);
    },
    async create(input: ResourceInput): Promise<Outcome<ResourceRow>> {
      return gateway.create(input);
    },
    async update(id: string, patch: ResourceInput): Promise<Outcome<ResourceRow | null>> {
      return gateway.update(id, patch);
    },
    async remove(id: string): Promise<Outcome<boolean>> {
      return gateway.remove(id);
    },
  };
}
