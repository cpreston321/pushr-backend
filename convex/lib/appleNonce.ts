/**
 * Sign in with Apple tokens are issued for the app's bundle id, so every pushr
 * server, cloud or self-hosted, accepts them. To stop a self-hosted operator
 * replaying a user's token at pushr cloud within its hour of validity, the app
 * puts the server's host in the nonce ("<host>:<random>"), and each server only
 * accepts nonces that name itself. Better Auth already checks the token's nonce
 * claim matches the one sent, so checking the sent nonce is enough.
 */
export function nonceIsForServer(nonce: string | undefined, serverUrls: (string | undefined)[]): boolean {
  if (!nonce) return false;
  const hosts = serverUrls.flatMap((url) => {
    try {
      return url ? [new URL(url).host] : [];
    } catch {
      return [];
    }
  });
  return hosts.some((host) => nonce.startsWith(`${host}:`) && nonce.length > host.length + 1);
}
