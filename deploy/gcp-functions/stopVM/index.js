const functions = require('@google-cloud/functions-framework');
const compute = require('@google-cloud/compute');

const PROJECT = process.env.GCP_PROJECT || 'sitesnag';
const VM_NAME = process.env.VM_NAME || 'sitesnag';
const VM_ZONE = process.env.VM_ZONE || 'asia-southeast1-c';
const STOP_AT_PCT = Number(process.env.STOP_AT_PCT || '1.0');

const instancesClient = new compute.InstancesClient();

functions.cloudEvent('stopVM', async (cloudEvent) => {
  let payload = {};
  try {
    const raw = Buffer.from(cloudEvent.data.message.data, 'base64').toString('utf8');
    payload = JSON.parse(raw);
  } catch (err) {
    console.error('decode failed:', err.message);
    return;
  }

  const attrs = (cloudEvent.data && cloudEvent.data.message && cloudEvent.data.message.attributes) || {};
  const cost = Number(payload.costAmount);
  const budget = Number(payload.budgetAmount);
  const actualThreshold = Number(payload.alertThresholdExceeded);
  const forecastThreshold = Number(payload.forecastThresholdExceeded);
  const isForecastOnly = Number.isFinite(forecastThreshold) && !Number.isFinite(actualThreshold);

  console.log(JSON.stringify({
    msg: 'budget event',
    budgetDisplayName: payload.budgetDisplayName,
    cost,
    budget,
    actualThreshold: Number.isFinite(actualThreshold) ? actualThreshold : null,
    forecastThreshold: Number.isFinite(forecastThreshold) ? forecastThreshold : null,
    currency: payload.currencyCode,
    schemaVersion: attrs.schemaVersion,
    budgetId: attrs.budgetId,
  }));

  if (!Number.isFinite(cost) || !Number.isFinite(budget) || budget <= 0) {
    console.log(`fail-safe: cost=${cost} budget=${budget} — refusing to stop`);
    return;
  }
  if (isForecastOnly) {
    console.log('forecast-only alert — not stopping');
    return;
  }
  if (!Number.isFinite(actualThreshold) || actualThreshold < STOP_AT_PCT) {
    console.log(`threshold=${actualThreshold} < STOP_AT_PCT=${STOP_AT_PCT} — not stopping`);
    return;
  }

  console.log(`STOP: cost $${cost} crossed ${actualThreshold * 100}% of budget $${budget}. Stopping ${VM_NAME} in ${VM_ZONE}.`);
  const [op] = await instancesClient.stop({
    project: PROJECT,
    zone: VM_ZONE,
    instance: VM_NAME,
  });
  console.log(`stop op started: ${op.name}`);
});
