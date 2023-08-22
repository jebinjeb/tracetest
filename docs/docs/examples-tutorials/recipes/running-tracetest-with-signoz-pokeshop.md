# Running Tracetest with SigNoz (OpenTelemetry Collector & Pokeshop API)

:::note
[Check out the source code on GitHub here.](https://github.com/kubeshop/tracetest/tree/main/examples/tracetest-signoz-pokeshop)
:::

[Tracetest](https://tracetest.io/) is a testing tool based on [OpenTelemetry](https://opentelemetry.io/) that allows you to test your distributed application. It allows you to use data from distributed traces generated by OpenTelemetry to validate and assert if your application has the desired behavior defined by your test definitions.

[SigNoz](https://signoz.io/) is an open-source observability tool. A single tool for all your observability needs - APM, logs, metrics, exceptions, alerts, and dashboards powered by a powerful query builder.

[Pokeshop API](https://docs.tracetest.io/live-examples/pokeshop/overview) is a testing ground, the team at Tracetest has implemented a sample instrumented API around the [PokeAPI](https://pokeapi.co/).

## Pokeshop API with SigNoz and Tracetest

This is a simple quick start guide on how to configure a fully instrumented API to be used with Tracetest for enhancing your E2E and integration tests with trace-based testing. The infrastructure will use SigNoz as the trace data store and the Pokeshop API to generate the telemetry data.

## Prerequisites

You will need [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) installed on your machine to run this quick start app!

## Project Structure

The project is built with Docker Compose.

### 1. Tracetest

The `collector.config.yaml` file, `tracetest-provision.yaml`, and `tracetest-config.yaml` in the `tracetest` directory are for the configuring Tracetest and it's OpenTelemetry Collector.

### 2. SigNoz

The `signoz` directory contains all files required to configure SigNoz.

### Docker Compose Network

All `services` in the `docker-compose.yaml` are on the same network and will be reachable by hostname from within other services. E.g. `tracetest:4317` in the `tracetest/collector.config.yaml` will map to the `tracetest` service, where the port `4317` is the port where Tracetest accepts telemetry data.

## Pokeshop API

The Pokeshop API is a fully instrumented REST API that makes use of different services to mimic a real life scenario.

It is instrumented using the [OpenTelemetry standards for Node.js](https://opentelemetry.io/docs/instrumentation/js/getting-started/nodejs/), sending the data to the ADOT collector that will be pushing the telemetry information to both the AWS X-Ray service.

This is a fragment from the main tracing file from the [Pokeshop API repo.](https://github.com/kubeshop/pokeshop)

```typescript
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import * as opentelemetry from '@opentelemetry/api';
import { api, NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import * as dotenv from 'dotenv';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { AmqplibInstrumentation } from '@opentelemetry/instrumentation-amqplib';
import { SpanStatusCode } from '@opentelemetry/api';
import { B3Propagator } from '@opentelemetry/propagator-b3';

dotenv.config();
api.propagation.setGlobalPropagator(new B3Propagator());

const { COLLECTOR_ENDPOINT = '', SERVICE_NAME = 'pokeshop' } = process.env;

let globalTracer: opentelemetry.Tracer | null = null;

async function createTracer(): Promise<opentelemetry.Tracer> {
  const collectorExporter = new OTLPTraceExporter({
    url: COLLECTOR_ENDPOINT,
  });

  const spanProcessor = new BatchSpanProcessor(collectorExporter);
  const sdk = new NodeSDK({
    traceExporter: collectorExporter,
    // @ts-ignore
    instrumentations: [new IORedisInstrumentation(), new PgInstrumentation(), new AmqplibInstrumentation()],
  });

  sdk.configureTracerProvider({}, spanProcessor);
  sdk.addResource(
    new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
    })
  );

  await sdk.start();
  process.on('SIGTERM', () => {
    sdk
      .shutdown()
      .then(
        () => console.log('SDK shut down successfully'),
        err => console.log('Error shutting down SDK', err)
      )
      .finally(() => process.exit(0));
  });

  const tracer = opentelemetry.trace.getTracer(SERVICE_NAME);

  globalTracer = tracer;

  return globalTracer;
}
```

The `docker-compose.yaml` file includes the definitions for all of the required services by the Pokeshop API, which includes:

- **Postgres** - To save Pokemon information.
- **Redis** - For in memory strage.
- **RabbitMQ** - For async processing use cases.
- **API** - The Pokeshop API main container.
- **Worker** - The Pokeshop worker instance.

```yaml
version: "3"

#... 

services:
  #... 

  # Demo
  postgres:
    image: postgres:14
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_USER: postgres
    healthcheck:
      test: pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"
      interval: 1s
      timeout: 5s
      retries: 60
    ports:
      - 5432:5432

  demo-cache:
    image: redis:6
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 1s
      timeout: 3s
      retries: 60

  demo-queue:
    image: rabbitmq:3.8-management
    restart: unless-stopped
    healthcheck:
      test: rabbitmq-diagnostics -q check_running
      interval: 1s
      timeout: 5s
      retries: 60

  demo-api:
    image: kubeshop/demo-pokemon-api:latest
    restart: unless-stopped
    pull_policy: always
    environment:
      REDIS_URL: demo-cache
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/postgres?schema=public
      RABBITMQ_HOST: demo-queue
      POKE_API_BASE_URL: https://pokeapi.co/api/v2
      COLLECTOR_ENDPOINT: http://otel-collector:4317
      NPM_RUN_COMMAND: api
    ports:
      - "8081:8081"
    healthcheck:
      test: ["CMD", "wget", "--spider", "localhost:8081"]
      interval: 1s
      timeout: 3s
      retries: 60
    depends_on:
      postgres:
        condition: service_healthy
      demo-cache:
        condition: service_healthy
      demo-queue:
        condition: service_healthy

  demo-worker:
    image: kubeshop/demo-pokemon-api:latest
    restart: unless-stopped
    pull_policy: always
    environment:
      REDIS_URL: demo-cache
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/postgres?schema=public
      RABBITMQ_HOST: demo-queue
      POKE_API_BASE_URL: https://pokeapi.co/api/v2
      COLLECTOR_ENDPOINT: http://otel-collector:4317
      NPM_RUN_COMMAND: worker
    depends_on:
      postgres:
        condition: service_healthy
      demo-cache:
        condition: service_healthy
      demo-queue:
        condition: service_healthy

  demo-rpc:
    image: kubeshop/demo-pokemon-api:latest
    restart: unless-stopped
    pull_policy: always
    environment:
      REDIS_URL: demo-cache
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/postgres?schema=public
      RABBITMQ_HOST: demo-queue
      POKE_API_BASE_URL: https://pokeapi.co/api/v2
      COLLECTOR_ENDPOINT: http://otel-collector:4317
      NPM_RUN_COMMAND: rpc
    ports:
      - 8082:8082
    healthcheck:
      test: ["CMD", "lsof", "-i", "8082"]
      interval: 1s
      timeout: 3s
      retries: 60
    depends_on:
      postgres:
        condition: service_healthy
      demo-cache:
        condition: service_healthy
      demo-queue:
        condition: service_healthy
  # Demo End
```

## Tracetest

The `docker-compose.yaml` includes two services related to Tracetest. The Tracetest instance also connects to the `postgres` service.

- **Postgres** - Postgres is a prerequisite for Tracetest to work. It stores trace data when running the trace-based tests.
- [**OpenTelemetry Collector**)](https://opentelemetry.io/docs/collector/getting-started/) - Vendor-agnostic way to receive, process and export telemetry data.
- [**Tracetest**](https://tracetest.io/) - Trace-based testing that generates end-to-end tests automatically from traces.

```yaml
version: "3"

# ...
services:

  # ...

  # Tracetest
  tracetest:
    image: kubeshop/tracetest:${TAG:-latest}
    platform: linux/amd64
    volumes:
      - type: bind
        source: ./tracetest/tracetest-config.yaml
        target: /app/tracetest.yaml
      - type: bind
        source: ./tracetest/tracetest-provision.yaml
        target: /app/provision.yaml
    command: --provisioning-file /app/provision.yaml
    ports:
      - 11633:11633
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      postgres:
        condition: service_healthy
      otel-collector:
        condition: service_started
    healthcheck:
      test: [ "CMD", "wget", "--spider", "localhost:11633" ]
      interval: 1s
      timeout: 3s
      retries: 60
    environment:
      TRACETEST_DEV: ${TRACETEST_DEV}

  otel-collector:
    image: otel/opentelemetry-collector:0.54.0
    command:
      - "--config"
      - "/otel-local-config.yaml"
    volumes:
      - ./tracetest/collector.config.yaml:/otel-local-config.yaml
    ports:
      - 4317:4317
    depends_on:
      signoz-otel-collector:
        condition: service_started
      signoz-otel-collector-metrics:
        condition: service_started
  # Tracetest End
```

Tracetest depends on Postgres and the OpenTelemetry Collector. Tracetest requires config files to be loaded via a volume. The volumes are mapped from the `tracetest` directory into the `root` directory of the Tracetest container instance and the respective config files.

The `collector.config.yaml` file contains the OpenTelemetry Collector configuration that enables routing traces from the Pokeshop API to both Tracetest and SigNoz.

```yaml
# collector.config.yaml

receivers:
  otlp:
    protocols:
      grpc:
      http:

processors:
  batch:
    timeout: 100ms

  # Data sources: traces
  probabilistic_sampler:
    hash_seed: 22
    sampling_percentage: 100

exporters:
  # OTLP for Tracetest
  otlp/tracetest:
    endpoint: tracetest:4317 # Send traces to Tracetest.
    # Read more in docs here: https://docs.tracetest.io/configuration/connecting-to-data-stores/opentelemetry-collector
    tls:
      insecure: true
  # OTLP for Signoz
  otlp/signoz:
    endpoint: signoz-otel-collector:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [probabilistic_sampler, batch]
      exporters: [otlp/signoz,otlp/tracetest]
```

The `tracetest-config.yaml` file contains the basic setup of connecting Tracetest to the Postgres instance. It also enables forwarding Tracetest's internal telemetry to SigNoz as well, with the `telemetry` and `server` config.

```yaml
# tracetest-config.yaml

postgres:
  host: postgres
  user: postgres
  password: postgres
  port: 5432
  dbname: postgres
  params: sslmode=disable

telemetry:
  exporters:
    collector:
      serviceName: tracetest
      sampling: 100 # 100%
      exporter:
        type: collector
        collector:
          endpoint: otel-collector:4317

server:
  telemetry:
    exporter: collector
    applicationExporter: collector

```

The `tracetest-provision.yaml` file defines the trace data store, set to SigNoz, meaning the traces will be forwarded via the OpenTelemetry Collector to both Tracetest when running tests and SigNoz where they are stored.

```yaml
# tracetest-provision.yaml

---
type: PollingProfile
spec:
  name: Default
  strategy: periodic
  default: true
  periodic:
    retryDelay: 5s
    timeout: 10m

---
type: DataStore
spec:
  name: Signoz
  type: signoz

---
type: TestRunner
spec:
  id: current
  name: default
  requiredGates:
    - analyzer-score
    - test-specs

---
type: Demo
spec:
  type: pokeshop
  enabled: true
  name: pokeshop
  opentelemetryStore: {}
  pokeshop:
    httpEndpoint: http://demo-api:8081
    grpcEndpoint: demo-rpc:8082
```

How do traces reach SigNoz?

The Pokeshop API code uses the native Node.js OpenTelemetry modules which send information to the OpenTelemetry Collector to be processed and then sent to the internal SigNoz OpenTelemetry Collector.

## SigNoz

The `docker-compose.yaml` includes 7 services related to SigNoz.

- [**Zookeeper**](https://zookeeper.apache.org/) - ZooKeeper is a centralized service for maintaining configuration information, naming, providing distributed synchronization, and providing group services.
- [**ClickHouse**](https://clickhouse.com/) - ClickHouse is the fastest and most resource efficient open-source database for real-time apps and analytics.
- [**SigNoz - Alert Manager**](https://github.com/SigNoz/alertmanager) - The `Alertmanager` handles alerts sent by client applications such as the Prometheus server. It takes care of deduplicating, grouping, and routing them to the correct receiver integrations such as email, PagerDuty, or OpsGenie. It also takes care of silencing and inhibition of alerts.
- [**SigNoz - Query Service**](https://github.com/SigNoz/signoz/tree/develop/pkg/query-service) - Handles querying for data.
- [**SigNoz - Front end**](https://github.com/SigNoz/signoz/tree/develop/frontend) - The SigNoz front-end app.
- [**SigNoz - OpenTelemetry Collector**)](https://opentelemetry.io/docs/collector/getting-started/) - Vendor-agnostic way to receive, process and export telemetry data.
- [**SigNoz - OpenTelemetry Collector Metrics**)](https://opentelemetry.io/docs/collector/getting-started/) - Vendor-agnostic way to receive, process and export telemetry data. This service is dedicated to metrics.

```yaml
version: "3"

# ...
services:

  # ...

  # SigNoz
  zookeeper-1:
    image: bitnami/zookeeper:3.7.1
    container_name: zookeeper-1
    hostname: zookeeper-1
    user: root
    volumes:
      - ./signoz/data/zookeeper-1:/bitnami/zookeeper
    environment:
      - ZOO_SERVER_ID=1
      - ALLOW_ANONYMOUS_LOGIN=yes
      - ZOO_AUTOPURGE_INTERVAL=1

  clickhouse:
    restart: on-failure
    image: clickhouse/clickhouse-server:22.8.8-alpine
    tty: true
    depends_on:
      - zookeeper-1
    logging:
      options:
        max-size: 50m
        max-file: "3"
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "localhost:8123/ping"]
      interval: 30s
      timeout: 5s
      retries: 3
    ulimits:
      nproc: 65535
      nofile:
        soft: 262144
        hard: 262144
    container_name: clickhouse
    hostname: clickhouse
    volumes:
      - ./signoz/clickhouse-config.xml:/etc/clickhouse-server/config.xml
      - ./signoz/clickhouse-users.xml:/etc/clickhouse-server/users.xml
      - ./signoz/custom-function.xml:/etc/clickhouse-server/custom-function.xml
      - ./signoz/clickhouse-cluster.xml:/etc/clickhouse-server/config.d/cluster.xml
      - ./signoz/data/clickhouse/:/var/lib/clickhouse/
      - ./signoz/user_scripts:/var/lib/clickhouse/user_scripts/

  alertmanager:
    image: signoz/alertmanager:${ALERTMANAGER_TAG:-0.23.1}
    volumes:
      - ./signoz/data/alertmanager:/data
    depends_on:
      query-service:
        condition: service_healthy
    restart: on-failure
    command:
      - --queryService.url=http://query-service:8085
      - --storage.path=/data

  query-service:
    image: signoz/query-service:${DOCKER_TAG:-0.22.0}
    command: ["-config=/root/config/prometheus.yml"]
    volumes:
      - ./signoz/prometheus.yml:/root/config/prometheus.yml
      - ./signoz/data/signoz/:/var/lib/signoz/
    environment:
      - ClickHouseUrl=tcp://clickhouse:9000/?database=signoz_traces
      - ALERTMANAGER_API_PREFIX=http://alertmanager:9093/api/
      - SIGNOZ_LOCAL_DB_PATH=/var/lib/signoz/signoz.db
      - DASHBOARDS_PATH=/root/config/dashboards
      - STORAGE=clickhouse
      - GODEBUG=netdns=go
      - TELEMETRY_ENABLED=true
      - DEPLOYMENT_TYPE=docker-standalone-amd
    restart: on-failure
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "localhost:8080/api/v1/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    depends_on:
      clickhouse:
        condition: service_healthy

  frontend:
    image: signoz/frontend:${DOCKER_TAG:-0.22.0}
    restart: on-failure
    depends_on:
      - alertmanager
      - query-service
    ports:
      - 3301:3301
    volumes:
      - ./signoz/common/nginx-config.conf:/etc/nginx/conf.d/default.conf

  signoz-otel-collector:
    image: signoz/signoz-otel-collector:${OTELCOL_TAG:-0.79.2}
    command: ["--config=/etc/otel-collector-config.yaml", "--feature-gates=-pkg.translator.prometheus.NormalizeName"]
    user: root # required for reading docker container logs
    volumes:
      - ./signoz/otel-collector-config.yaml:/etc/otel-collector-config.yaml
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
    environment:
      - OTEL_RESOURCE_ATTRIBUTES=host.name=signoz-host,os.type=linux
      - DOCKER_MULTI_NODE_CLUSTER=false
      - LOW_CARDINAL_EXCEPTION_GROUPING=false
    restart: on-failure
    depends_on:
      clickhouse:
        condition: service_healthy

  signoz-otel-collector-metrics:
    image: signoz/signoz-otel-collector:${OTELCOL_TAG:-0.79.2}
    command: ["--config=/etc/otel-collector-metrics-config.yaml", "--feature-gates=-pkg.translator.prometheus.NormalizeName"]
    volumes:
      - ./signoz/otel-collector-metrics-config.yaml:/etc/otel-collector-metrics-config.yaml
    restart: on-failure
    depends_on:
      clickhouse:
        condition: service_healthy
  # SigNoz End
```

SigNoz depends on ClickHouse and Zookeeper. The SigNoz services require config files to be loaded via volumes. The volumes are mapped from the `signoz` directory.

## Run the Pokeshop API, SigNoz and Tracetest

To start all the services, run this command:

```bash
docker-compose up
```

This will start your Tracetest instance on `http://localhost:11633/`. Open it and start creating tests!

Make sure to use the `http://demo-api:8081/` URL in your test creation, because your Pokeshop API and Tracetest are in the same network.

## Run Tracetest Tests with the Tracetest CLI

First, [install the CLI](https://docs.tracetest.io/getting-started/installation#install-the-tracetest-cli).
Then, configure the CLI:

```bash
tracetest configure --endpoint http://localhost:11633
```

Once configured, you can run a test against the Tracetest instance via the terminal.

Check out the `tests/test.yaml` file.

```yaml
# tests/test.yaml

type: Test
spec:
  id: ZVJwkpC4g
  name: Pokeshop - Import
  description: Import a Pokemon
  trigger:
    type: http
    httpRequest:
      method: POST
      url: http://demo-api:8081/pokemon/import
      body: '{"id":6}'
      headers:
      - key: Content-Type
        value: application/json
  specs:
  - selector: span[tracetest.span.type="http"]
    name: "All HTTP Spans: Status  code is 200"
    assertions:
    - attr:http.status_code = 200
  - selector: span[tracetest.span.type="general" name="import pokemon"]
    name: Validate that this span always exists after the message queue
    assertions:
    - attr:tracetest.selected_spans.count  =  1
    - attr:span.events not-contains "exception"
  - selector: span[tracetest.span.type="database" name="get pokemon_6" db.system="redis" db.operation="get" db.redis.database_index="0"]
    name: Validate that Redis is using Charizard.
    assertions:
    - attr:db.payload = '{"key":"pokemon_6"}'
  - selector: span[tracetest.span.type="database" name="create postgres.pokemon" db.system="postgres" db.name="postgres" db.user="postgres" db.operation="create" db.sql.table="pokemon"]
    name: Validate that the Postgres has Charizard.
    assertions:
    - attr:db.result contains "charizard"
```

This file defines a test the same way you would through the Web UI.

To run the test, run this command in the terminal:

```bash
tracetest run test -f ./tests/test.yaml
```

```bash title="Output:"
✔ Pokeshop - Import (http://localhost:11633/test/ZVJwkpC4g/run/1/test) - trace id: 4eff1e124f67cf7a802b3c4fc51c19d4
	✔ All HTTP Spans: Status  code is 200
	✔ Validate that this span always exists after the message queue
	✔ Validate that Redis is using Charizard.
	✔ Validate that the Postgres has Charizard.
```

![tracetest web ui overview](https://res.cloudinary.com/djwdcmwdz/image/upload/v1692356467/Blogposts/Docs/screely-1692356427154_ewzduy.png)

## View Trace Spans Over Time in SigNoz

To access a historical overview of all the trace spans the Pokeshop App generates, jump over to SigNoz.

![signoz trace overview](https://res.cloudinary.com/djwdcmwdz/image/upload/v1692364823/Blogposts/Docs/screely-1692364815231_birvhj.png)

You can also drill down into a particular trace.

![signoz trace drilldown](https://res.cloudinary.com/djwdcmwdz/image/upload/v1692364964/Blogposts/Docs/screely-1692364957669_te7pe2.png)

With SigNoz and Tracetest, you get the best of both worlds. You can run trace-based tests and automate running E2E and integration tests against real trace data. And, use SigNoz to get a historical overview of all traces your distributed application generates.

## Learn More

Please visit our [examples in GitHub](https://github.com/kubeshop/tracetest/tree/main/examples) and join our [Discord Community](https://discord.gg/8MtcMrQNbX) for more info!