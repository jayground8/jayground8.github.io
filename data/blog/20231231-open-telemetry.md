---
title: 'OpenTelemetry with Minikube'
date: '2023-12-31'
tags: [opentelemetry, kubernetes]
images: ['/static/images/social-banner.png']
summary: 'OpenTelemetry collector를 사용하여 tracing과 logging을 같이 하는 것을 검토하였다. Kubernetes와 멀어져 있던 사이에 OpenTelemetry 커뮤니티가 엄청나게 성장한 것을 깨닫게 되었다. Log에 traceID를 남기고 그걸로 Tracing 정보를 볼 수 있도록 구성했고, Grafana 하나에서 통합적으로 볼 수 있도록 Loki와 Tempo를 Exporter로 사용했다. 아직 Python과 Nodejs에서는 Log쪽의 상태는 Development나 Experimental이기 때문에, receiver에서 filelog를 사용하여 Kubernetes log file을 fluentbit처럼 tail해서 가져오고 traceId를 log에 넣어주는 instrument libary를 사용했다.'
---

## Minikube 환경

Mac에서 Minikube를 사용하였기 때문에 아래와 같이 Minikube cluster를 실행하였다.

```bash
brew install hyperkit
minikube start --container-runtime=containerd --cni=cilium --driver=hyperkit --kubernetes-version=v1.26.12
```

[예제 소스코드](https://github.com/jayground8/example-k8s-with-OTel)을 Clone한다.

## Loki, Tempo, Grafana

테스트를 위해서 Loki, Tempo, Grafana를 Helm으로 실행한다.

Grafana에서 Lok와 Tempo를 아래와 같이 datasource로 정의해준다. 여기서 trace_id를 regex로 찾아서 tempo에서 보여줄 수 있도록 해줄 수 있다. 그렇게 설정하고 나면 아래 그림처럼 label에 link를 추가할 수 있고, 누르면 바로 Tracing 정보를 같이 볼 수 있다. Grafana Labs에서 이렇게 OSS로 제공하여 우리가 쉽게 사용할 수 있다라는 것에 다시 한번 감탄과 감사함을 느낀다. 😍

<img src="/static/images/otel-trace-link.png" alt="tracing link" />

<img src="/static/images/otel-grafana-tempo-integration.png" alt="tracing info" />

`values.yml`

```yml
datasources:
  datasources.yaml:
    apiVersion: 1
    datasources:
      - name: Loki
        type: loki
        access: proxy
        url: http://loki:3100
        basicAuth: false
        jsonData:
          maxLines: 1000
          derivedFields:
            - datasourceName: Tempo
              datasourceUid: tempo
              matcherRegex: trace_id=(\w+)
              name: traceID
              url: $${__value.raw}
      - name: Tempo
        type: tempo
        access: proxy
        orgId: 1
        url: http://tempo:3100
        basicAuth: false
        isDefault: false
        version: 1
        editable: false
        apiVersion: 1
        uid: tempo
```

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm install loki grafana/loki --values helm/loki/values.yml
helm install tempo grafana/tempo
helm install grafana grafana/grafana --values helm/grafana/values.yml
```

## OpenTelemetry Collector

OpenTelemetry Collector는 receiver, processor, exporter로 구성되어 있다. Log는 `filelog` receiver를 사용하여, Kubernetes log file의 log를 수집한다. Tracing은 otlp receiver가 OpenTelemetry Protocol로 받을 수 있게 grpc, http 서버를 띄우게 된다. `Nestjs` Nodejs App에서 해당 otlp receiver로 tracing 정보를 보내게 되고, `FastAPI` Python App에서도 동일하게 otlp receiver로 tracing 정보를 보내게 된다. 이렇게 수집한 Log는 exporter로 Loki backend에 최종적으로 보내고, Trace는 exporter로 Tempo에 보낸다. 이렇게 보내진 정보는 Grafana에서 Visualize하여 보게 된다. Log는 Processor에서 parsing을 하고, Loki에서 indexing을 하는 label정보를 추가 해주는 작업을 한다.

최종적으로 Helm values값은 아래와 같다. jaeger, prometheus, zipkin은 사용하지 않아서 default값으로 실행되지 않게 null로 설정을 해주었다. Tracing의 경우에 OpenTelemetry Collector가 정상적으로 받았는지 확인하기 위해서 exporters에 `debug`를 추가하였다.

`values.yml`

```yaml
config:
  receivers:
    jaeger: null
    prometheus: null
    zipkin: null
    filelog:
      include:
        - /var/log/pods/*/*/*.log
      start_at: beginning
      include_file_path: true
      include_file_name: false
      operators:
        # Find out which format is used by kubernetes
        - type: router
          id: get-format
          routes:
            - output: parser-containerd
              expr: 'body matches "^[^ Z]+Z"'
        # Parse CRI-Containerd format
        - type: regex_parser
          id: parser-containerd
          regex: '^(?P<time>[^ ^Z]+Z) (?P<stream>stdout|stderr) (?P<logtag>[^ ]*) ?(?P<log>.*)$'
          output: extract_metadata_from_filepath
          timestamp:
            parse_from: attributes.time
            layout: '%Y-%m-%dT%H:%M:%S.%LZ'
        # Extract metadata from file path
        - type: regex_parser
          id: extract_metadata_from_filepath
          regex: '^.*\/(?P<namespace>[^_]+)_(?P<pod_name>[^_]+)_(?P<uid>[a-f0-9\-]{36})\/(?P<container_name>[^\._]+)\/(?P<restart_count>\d+)\.log$'
          parse_from: attributes["log.file.path"]
          cache:
            size: 128 # default maximum amount of Pods per Node is 110
        # Rename attributes
        - type: move
          from: attributes["log.file.path"]
          to: resource["filename"]
        - type: move
          from: attributes.container_name
          to: resource["container"]
        - type: move
          from: attributes.namespace
          to: resource["namespace"]
        - type: move
          from: attributes.pod_name
          to: resource["pod"]
        - type: add
          field: resource["cluster"]
          value: 'minikube'
  service:
    pipelines:
      traces:
        receivers:
          - otlp
        exporters:
          - debug
          - otlp
      metrics:
        receivers:
          - otlp
      logs:
        receivers:
          - filelog
        processors:
          - resource
        exporters:
          - loki
  processors:
    resource:
      attributes:
        - action: insert
          key: loki.format
          value: json
        - action: insert
          key: loki.resource.labels
          value: pod, namespace, container, cluster, filename
  exporters:
    loki:
      endpoint: http://loki.default.svc.cluster.local:3100/loki/api/v1/push
    otlp:
      endpoint: tempo.default.svc.cluster.local:4317
      tls:
        insecure: true
    debug:
      verbosity: detailed
ports:
  jaeger-compact:
    enabled: false
  jaeger-thrift:
    enabled: false
  jaeger-grpc:
    enabled: false
  zipkin:
    enabled: false
mode: daemonset
presets:
  logsCollection:
    enabled: true
    storeCheckpoints: true
```

[OpenTelemetry를 Agent 방식](https://opentelemetry.io/docs/collector/deployment/agent/)으로 배포를 한다. 그래서 DaemonSet으로 `opentelemetry-collector-agent`가 생성된다.

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm install opentelemetry-collector open-telemetry/opentelemetry-collector \
--values helm/opentelemetry-collector/values.yml
```

## App

이제 우리가 수집하려는 Application에서 Log, Trace, Metric 정보를 제공해야 한다. 여기서 Instrumentation을 통해서 source 코드를 일일이 수정해서 Trace 정보를 넣어주지 않아도 Trace 정보를 생성할 수 있다.

### Nodejs

Nestjs를 사용하고 잇는데, `@opentelemetry/instrumentation-nestjs-core`처럼 imstumentation library를 제공하고 있어서 사용할 수 있다.

```ts
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core'
```

🧐 `@opentelemetry/instrumentation-winston`에서 log를 남길 때, trace_id를 넣어 줄거라 기대했는데 남지 않아서 확인 필요하다.

```ts
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core'
import { WinstonInstrumentation } from '@opentelemetry/instrumentation-winston'

export const otelSDK = new NodeSDK({
  serviceName: `api-node`,
  traceExporter: new OTLPTraceExporter({
    url: `http://${process.env.NODE_IP}:4318/v1/traces`,
  }),
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new NestInstrumentation(),
    new WinstonInstrumentation({
      enabled: true,
      logHook: (_span, record) => {
        record['resource.service.name'] = 'test-service'
      },
    }),
  ],
})

process.on('SIGTERM', () => {
  otelSDK
    .shutdown()
    .then(
      () => console.log('SDK shut down successfully'),
      (err) => console.log('Error shutting down SDK', err)
    )
    .finally(() => process.exit(0))
})
```

Docker로 build한 Image를 minikube 명령어를 사용해서 cluster에 load한다.

```bash
docker build -t my-node-app ./my-node-app
minikube image load my-node-app:latest
```

minikube의 명령어로 image가 정상적으로 load되었는지 확인할 수 있다.

```bash
$ minikube image list
docker.io/library/my-node-app:latest
```

Local에 있는 Image를 사용하기 위해서 `imagePullPolicy: Never`로 설정을 해준다. `OTEL_LOG_LEVEL` 환경변수는 Nodejs에서 OpenTelemetry SDK libary의 Debug 로그를 보기 위해서 설정했다. `NODE_IP`는 OpenTelmetry Collector가 DaemonSet으로 띄고 HostPort를 설정하고 있다. 그래서 Node IP를 환경 변수로 넘겨주었다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-node-app
  namespace: default
spec:
  replicas: 1
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app: my-node-app
  template:
    metadata:
      labels:
        app: my-node-app
    spec:
      containers:
        - image: my-node-app
          name: api-node
          imagePullPolicy: Never
          ports:
            - name: api-node-port
              containerPort: 3000
          env:
            - name: OTEL_LOG_LEVEL
              value: DEBUG
            - name: NODE_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.hostIP
```

```bash
kubectl apply -f k8s/my-node-app/deployment.yml
kubectl apply -f k8s/my-node-app/service.yml
```

### Python

Python은 FastAPI로 간단한 API 서버를 만들었다. 동일하게 제공하는 intrumentation library를 사용하여 설정하였고, Nodejs는 OpenTelemetry Collector가 연결할 때 http로 열려 있는 4318 포트 연결했지만, 여기에서 grpc로 열려 있는 4317 포트로 연결하였다. Python에서 Log가 Experimental status로 사용할 수 있지만, 동일하게 `opentelemetry.instrumentation.logging`를 통해서 log에 Trace ID를 남기고 Kubernetes log file을 tail하도록 하였다.

```python
import logging
import os
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from fastapi import FastAPI

resource = Resource.create({"service.name": "api-python"})
trace.set_tracer_provider(TracerProvider(resource=resource))
trace.get_tracer_provider().add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=f"http://{os.environ.get('NODE_IP')}:4317"))
)

app = FastAPI()
logger = logging.getLogger(__name__)

@app.get("/")
def read_root():
    logger.info("hello world!")
    return "Hello From Python App!"

FastAPIInstrumentor.instrument_app(app)
LoggingInstrumentor().instrument(set_logging_format=True)
```

서비스간의 통신을 위해서 예제코드의 Python App도 동일하게 반복한다.

```bash
docker build -t my-python-app ./my-python-app
minikube image load my-python-app:latest
kubectl apply -f k8s/my-python-app/deployment.yml
kubectl apply -f k8s/my-python-app/service.yml
```

### 서비스간의 통신

client -> nodejs app -> python app으로 호출하는 것을 실행해본다.

nodejs app Service에 Port Fowarding을 하고 `/something`에 요청하면 nodejs app이 python app 요청하여 받아온 응답값을 전달하게 된다.

```bash
kubectl port-forward svc/my-node-app-svc 3000:3000
curl localhost:3000/something
```

tempo에서 아래와 같이 확인 할 수 있다.

<img src="/static/images/otel-trace-for-inter-service-communication.png" alt="trace for inter service communication" />

## 결론

많은 OpenSource Contributor들 덕분에 Tracing과 Logging을 쉽게 구성할 수 있었다. Loki에서 Regex로 Trace ID를 추출하고, 그것을 Tempo에서 바로 볼 수 있도록 링크를 달아줄 수 있는 것은 너무나 좋았다. 그리고 OpenTelemetry Collector를 사용하는 상황에서 FluentBit 때신에 Firelog receiver를 이용하는 것도 괜찮겠다는 생각이 들었다. 다양한 Instrumentation library도 체크해봐야겠다. 아직 Production Ready를 위해서는 Loki, Tempo, Open Collector의 가용성을 생각해서 배포도 다시 구성해야하고, 통신간에 TLS와 인증 부분도 추가해야 한다.
