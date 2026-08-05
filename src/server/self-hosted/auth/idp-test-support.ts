// Test-only Ed25519 idp-token signer.
//
// The production module (idp-token.ts) deliberately contains NO signing code:
// emails only ever VERIFIES idp tokens — minting is the IdP's job. Tests still
// need real signed tokens, so this helper builds a throwaway Ed25519 keypair and
// signs claims in the exact wire format the IdP emits (compact JWS, header
// `{ alg: "EdDSA", kid, typ: "at+jwt" }`). Imported ONLY by *.test.ts files.

import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import {
  IDP_TOKEN_ALG,
  IDP_TOKEN_ISSUER,
  IDP_TOKEN_TYPE,
  type IdpJwk,
  type IdpTokenClaims,
} from "./idp-token.js";

export interface TestIdpKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: IdpJwk;
}

/** Generate a throwaway Ed25519 keypair and its public JWK under `kid`. */
export function generateTestIdpKey(kid = "test-key-1"): TestIdpKey {
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

export interface TestIdpTokenInput {
  sub?: string;
  aud?: string;
  tid?: string;
  pt?: "user" | "service";
  scope?: string[];
  iss?: string;
  ttlSeconds?: number;
  nowMs?: number;
  jti?: string;
  /** Optional not-before, epoch seconds (the IdP may emit it; emails must read it). */
  nbf?: number;
  /** Override the JWS header (bad-alg / missing-kid fixtures). */
  header?: Record<string, unknown>;
}

/** Sign an IdP token exactly the way the IdP does. Every field is overridable. */
export function signTestIdpToken(key: TestIdpKey, input: TestIdpTokenInput = {}): {
  token: string;
  claims: IdpTokenClaims;
} {
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const claims: IdpTokenClaims = {
    iss: input.iss ?? IDP_TOKEN_ISSUER,
    aud: input.aud ?? "emails",
    sub: input.sub ?? "sp-test-principal",
    tid: input.tid ?? "11111111-2222-3333-4444-555555555555",
    pt: input.pt ?? "service",
    scope: input.scope ?? ["emails:*"],
    iat: nowSec,
    exp: nowSec + (input.ttlSeconds ?? 3600),
    jti: input.jti ?? "jti-test-1",
    ...(input.nbf !== undefined ? { nbf: input.nbf } : {}),
  };
  const header = input.header ?? { alg: IDP_TOKEN_ALG, kid: key.kid, typ: IDP_TOKEN_TYPE };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const signature = edSign(null, Buffer.from(signingInput), key.privateKey);
  return { token: `${signingInput}.${Buffer.from(signature).toString("base64url")}`, claims };
}
