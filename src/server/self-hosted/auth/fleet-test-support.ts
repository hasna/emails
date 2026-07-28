// Test-only Ed25519 fleet-token signer.
//
// The production module (fleet-token.ts) deliberately contains NO signing code:
// emails only ever VERIFIES fleet tokens — minting is the IdP's job. Tests still
// need real signed tokens, so this helper builds a throwaway Ed25519 keypair and
// signs claims in the exact wire format the fleet IdP emits (compact JWS, header
// `{ alg: "EdDSA", kid, typ: "at+jwt" }`). Imported ONLY by *.test.ts files.

import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import {
  FLEET_TOKEN_ALG,
  FLEET_TOKEN_ISSUER,
  FLEET_TOKEN_TYPE,
  type FleetJwk,
  type FleetTokenClaims,
} from "./fleet-token.js";

export interface TestFleetKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: FleetJwk;
}

/** Generate a throwaway Ed25519 keypair and its public JWK under `kid`. */
export function generateTestFleetKey(kid = "test-key-1"): TestFleetKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "jwk" }) as { crv?: string; x?: string };
  if (pub.crv !== "Ed25519" || !pub.x) throw new Error("expected an Ed25519 keypair");
  return {
    kid,
    privateKey,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: pub.x, kid, use: "sig", alg: "EdDSA" },
  };
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export interface TestFleetTokenInput {
  sub?: string;
  aud?: string;
  tid?: string;
  pt?: "user" | "service";
  scope?: string[];
  iss?: string;
  ttlSeconds?: number;
  nowMs?: number;
  jti?: string;
  /** Override the JWS header (bad-alg / missing-kid fixtures). */
  header?: Record<string, unknown>;
}

/** Sign a fleet token exactly the way the IdP does. Every field is overridable. */
export function signTestFleetToken(key: TestFleetKey, input: TestFleetTokenInput = {}): {
  token: string;
  claims: FleetTokenClaims;
} {
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const claims: FleetTokenClaims = {
    iss: input.iss ?? FLEET_TOKEN_ISSUER,
    aud: input.aud ?? "emails",
    sub: input.sub ?? "sp-test-principal",
    tid: input.tid ?? "11111111-2222-3333-4444-555555555555",
    pt: input.pt ?? "service",
    scope: input.scope ?? ["emails:*"],
    iat: nowSec,
    exp: nowSec + (input.ttlSeconds ?? 3600),
    jti: input.jti ?? "jti-test-1",
  };
  const header = input.header ?? { alg: FLEET_TOKEN_ALG, kid: key.kid, typ: FLEET_TOKEN_TYPE };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const signature = edSign(null, Buffer.from(signingInput), key.privateKey);
  return { token: `${signingInput}.${Buffer.from(signature).toString("base64url")}`, claims };
}
