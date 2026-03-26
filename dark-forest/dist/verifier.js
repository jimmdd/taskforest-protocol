"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonTdxQuoteVerifier = void 0;
exports.verifyCertificateChainPem = verifyCertificateChainPem;
exports.assertTdxQuotePolicy = assertTdxQuotePolicy;
exports.buildVerifiedAttestationEnvelope = buildVerifiedAttestationEnvelope;
const node_crypto_1 = require("node:crypto");
function normalizeHex(value) {
    return value?.toLowerCase().replace(/^0x/, '');
}
function sha256Hex(data) {
    return (0, node_crypto_1.createHash)('sha256').update(data).digest('hex');
}
function ensureAllowed(label, value, allowed) {
    if (!allowed || allowed.length === 0)
        return;
    const normalized = normalizeHex(value);
    const expected = new Set(allowed.map((item) => normalizeHex(item)));
    if (!normalized || !expected.has(normalized)) {
        throw new Error(`TDX policy mismatch for ${label}`);
    }
}
function verifyCertificateChainPem(chainPem, trustedRootFingerprints, nowSec = Math.floor(Date.now() / 1000), graceSeconds = 0) {
    if (!chainPem.length)
        throw new Error('Missing certificate chain');
    const certs = chainPem.map((pem) => new node_crypto_1.X509Certificate(pem));
    for (let i = 0; i < certs.length; i += 1) {
        const cert = certs[i];
        const now = nowSec * 1000;
        if (Date.parse(cert.validFrom) > now)
            throw new Error('Certificate not yet valid');
        if (Date.parse(cert.validTo) + graceSeconds * 1000 < now)
            throw new Error('Certificate expired');
        if (i < certs.length - 1) {
            const issuer = certs[i + 1];
            if (!cert.verify(issuer.publicKey))
                throw new Error('Certificate chain signature invalid');
        }
    }
    if (trustedRootFingerprints?.length) {
        const root = certs[certs.length - 1];
        const fingerprint = sha256Hex(root.raw);
        const trusted = new Set(trustedRootFingerprints.map((item) => normalizeHex(item)));
        if (!trusted.has(normalizeHex(fingerprint))) {
            throw new Error('Certificate root is not trusted');
        }
    }
}
function assertTdxQuotePolicy(claims, policy, nowSec = Math.floor(Date.now() / 1000)) {
    if (claims.issuedAt > nowSec)
        throw new Error('TDX quote is not yet valid');
    if (claims.expiresAt < nowSec)
        throw new Error('TDX quote has expired');
    ensureAllowed('mrTd', claims.mrTd, policy.allowedMrTd);
    ensureAllowed('rtmr0', claims.rtmr0, policy.allowedRtmr0);
    ensureAllowed('rtmr1', claims.rtmr1, policy.allowedRtmr1);
    ensureAllowed('rtmr2', claims.rtmr2, policy.allowedRtmr2);
    ensureAllowed('rtmr3', claims.rtmr3, policy.allowedRtmr3);
    if (policy.requireCertificateChain) {
        verifyCertificateChainPem(claims.certificateChainPem ?? [], policy.trustedRootFingerprints, nowSec, policy.notAfterGraceSeconds ?? 0);
    }
}
class JsonTdxQuoteVerifier {
    constructor(verifier) {
        this.verifier = verifier;
    }
    async verifyQuote(quote, policy) {
        const claims = JSON.parse(Buffer.from(quote).toString('utf8'));
        assertTdxQuotePolicy(claims, policy);
        return {
            claims,
            verifier: this.verifier,
            verifiedAt: Math.floor(Date.now() / 1000),
        };
    }
}
exports.JsonTdxQuoteVerifier = JsonTdxQuoteVerifier;
function buildVerifiedAttestationEnvelope(escrowId, jobPubkey, mppSessionId, verified) {
    return {
        escrowId,
        jobPubkey,
        validator: verified.verifier,
        teePubkey: Array.from(verified.claims.teePubkey),
        mppSessionId,
        issuedAt: verified.claims.issuedAt,
        expiresAt: verified.claims.expiresAt,
    };
}
