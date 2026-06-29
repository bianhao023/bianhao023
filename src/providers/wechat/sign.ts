import { rsaSignSha256, rsaVerifySha256 } from '../../utils/crypto';
import { nonceStr } from '../../utils/ids';

/**
 * WeChat Pay v3 request signing.
 *
 * Signature string is exactly:
 *   HTTP-METHOD\nURL-PATH\nTIMESTAMP\nNONCE\nBODY\n
 * and is signed with the merchant private key (SHA256withRSA).
 */
export function buildAuthorizationHeader(params: {
  method: 'GET' | 'POST';
  urlPath: string;
  body: string;
  mchId: string;
  serialNo: string;
  privateKeyPem: string;
  timestamp?: string;
  nonce?: string;
}): string {
  const timestamp = params.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = params.nonce ?? nonceStr(32);
  const message = `${params.method}\n${params.urlPath}\n${timestamp}\n${nonce}\n${params.body}\n`;
  const signature = rsaSignSha256(message, params.privateKeyPem);

  return (
    `WECHATPAY2-SHA256-RSA2048 ` +
    `mchid="${params.mchId}",` +
    `nonce_str="${nonce}",` +
    `signature="${signature}",` +
    `timestamp="${timestamp}",` +
    `serial_no="${params.serialNo}"`
  );
}

/**
 * Verify a WeChat Pay v3 notification signature.
 * Signature string is: TIMESTAMP\nNONCE\nBODY\n  (verified with platform cert).
 */
export function verifyNotificationSignature(params: {
  timestamp: string;
  nonce: string;
  body: string;
  signatureB64: string;
  platformPublicKeyPem: string;
}): boolean {
  const message = `${params.timestamp}\n${params.nonce}\n${params.body}\n`;
  return rsaVerifySha256(message, params.signatureB64, params.platformPublicKeyPem);
}
