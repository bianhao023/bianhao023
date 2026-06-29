import { rsaSignSha256, rsaVerifySha256 } from '../../utils/crypto';

/**
 * Alipay RSA2 signing.
 *
 * The signature is computed over the parameters sorted by key and joined as
 * `k1=v1&k2=v2&...` using the RAW (url-decoded) values, excluding empty values
 * and the `sign` / `sign_type` keys.
 */
export function buildSignContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

export function signParams(params: Record<string, string>, privateKeyPem: string): string {
  return rsaSignSha256(buildSignContent(params), privateKeyPem);
}

/** Verify an Alipay async-notification signature. */
export function verifyParams(
  params: Record<string, string>,
  alipayPublicKeyPem: string,
): boolean {
  const sign = params['sign'];
  if (!sign) return false;
  const content = buildSignContent(params);
  return rsaVerifySha256(content, sign, alipayPublicKeyPem);
}
