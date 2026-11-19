const baseUrl = new URL(process.env.OPENAI_BASE_URL);
const hostname = baseUrl.hostname;
if (hostname === '127.0.0.1' || hostname === 'localhost') {
  console.log('export E2E_MODEL_HOST=host.docker.internal');
  console.log('export E2E_MODEL_IP=host-gateway');
} else {
  const response = await fetch(`https://dns.alidns.com/resolve?name=${encodeURIComponent(hostname)}&type=A`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`AliDNS lookup failed with HTTP ${response.status}`);
  const result = await response.json();
  const address = result.Answer?.find((item) => item.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(item.data))?.data;
  if (!address) throw new Error(`No IPv4 address found for the model API hostname ${hostname}`);
  console.log(`export E2E_MODEL_HOST=${hostname}`);
  console.log(`export E2E_MODEL_IP=${address}`);
}
