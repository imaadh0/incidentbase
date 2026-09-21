import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface TelemetryConfiguration {
  enabled: boolean;
  endpoint?: string;
  serviceName: string;
}

export interface TelemetryHandle {
  shutdown: () => Promise<void>;
}

const disabledTelemetry: TelemetryHandle = {
  shutdown: () => Promise.resolve(),
};

export function startTelemetry(configuration: TelemetryConfiguration): TelemetryHandle {
  if (!configuration.enabled) {
    return disabledTelemetry;
  }

  if (configuration.endpoint === undefined) {
    throw new Error('An OTLP endpoint is required when telemetry is enabled');
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: configuration.serviceName,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${configuration.endpoint.replace(/\/$/, '')}/v1/traces`,
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();

  return {
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}
