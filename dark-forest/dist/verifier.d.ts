import { PublicKey } from '@solana/web3.js';
export interface TdxQuoteVerificationPolicy {
    allowedMrTd?: string[];
    allowedRtmr0?: string[];
    allowedRtmr1?: string[];
    allowedRtmr2?: string[];
    allowedRtmr3?: string[];
    requireCertificateChain?: boolean;
    trustedRootFingerprints?: string[];
    notAfterGraceSeconds?: number;
}
export interface TdxQuoteClaims {
    teePubkey: Uint8Array;
    mrTd?: string;
    rtmr0?: string;
    rtmr1?: string;
    rtmr2?: string;
    rtmr3?: string;
    issuedAt: number;
    expiresAt: number;
    certificateChainPem?: string[];
}
export interface VerifiedTdxQuote {
    claims: TdxQuoteClaims;
    verifier: PublicKey;
    verifiedAt: number;
}
export interface TdxQuoteVerifier {
    verifyQuote(quote: Uint8Array, policy: TdxQuoteVerificationPolicy): Promise<VerifiedTdxQuote>;
}
export interface VerifiedAttestationEnvelope {
    escrowId: number;
    jobPubkey: PublicKey;
    validator: PublicKey;
    teePubkey: number[];
    mppSessionId: number[];
    issuedAt: number;
    expiresAt: number;
}
export declare function verifyCertificateChainPem(chainPem: string[], trustedRootFingerprints?: string[], nowSec?: number, graceSeconds?: number): void;
export declare function assertTdxQuotePolicy(claims: TdxQuoteClaims, policy: TdxQuoteVerificationPolicy, nowSec?: number): void;
export declare class JsonTdxQuoteVerifier implements TdxQuoteVerifier {
    private readonly verifier;
    constructor(verifier: PublicKey);
    verifyQuote(quote: Uint8Array, policy: TdxQuoteVerificationPolicy): Promise<VerifiedTdxQuote>;
}
export declare function buildVerifiedAttestationEnvelope(escrowId: number, jobPubkey: PublicKey, mppSessionId: number[], verified: VerifiedTdxQuote): VerifiedAttestationEnvelope;
