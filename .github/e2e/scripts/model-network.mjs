const baseUrl = new URL(process.env.OPENAI_BASE_URL);
const hostname = baseUrl.hostname;
if (hostname === '127.0.0.1' || hostname === 'localhost') {
  console.log('export E2E_MODEL_HOST=host.docker.internal');
  console.log('export E2E_MODEL_IP=host-gateway');
} else {
  const providers = [
    `https://dns.alidns.com/resolve?name=${encodeURIComponent(hostname)}&type=A`,
    `https://doh.pub/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
  ];
  let address;
  const failures = [];
  for (const provider of providers) {
    try {
      const response = await fetch(provider, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        failures.push(`HTTP ${response.status}`);
        continue;
      }
      const result = await response.json();
      address = result.Answer?.find((item) => item.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(item.data))?.data;
      if (address) break;
      failures.push(`status ${result.Status ?? 'unknown'}`);
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (!address && process.env.E2E_MODEL_HOST === hostname && process.env.E2E_MODEL_IP) {
    address = process.env.E2E_MODEL_IP;
  }
  if (!address) {
    throw new Error(`No public IPv4 address found for the model API hostname ${hostname}: ${failures.join('; ')}`);
  }
  console.log(`export E2E_MODEL_HOST=${hostname}`);
  console.log(`export E2E_MODEL_IP=${address}`);
}
