---
title: 'opentelemetry-operator 사용해보기'
date: '2024-05-26'
tags: ['kubernetes', 'opentelemetry']
images: ['/static/images/social-banner.png']
summary: '소스코드를 변경하지 않고 opentelemetry-operator의 Instrumentation CRD를 통해서 Python Application을 자동으로 Instrumentation을 해봤다. 이 과정에서 OpenTelemetry Logging의 경우에는 기존 Logging Libarary에 Bridge API로 연동하는 구조로 설계된 것을 알게 되었고, Python opentelemetry sdk가 logger에 handler를 추가하는 것을 알게 되었다. 또한 sitecustomize.py을 통해서 Python Application이 실행되기 전에 Instrumentation library를 셋팅하는 것을 이해하게 되었다. Gunicorn으로 Flask를 실행할 때와 Uvicorn으로 FastAPI를 실행할 때, Auto Instrumentation이 잘 되는 것을 확인하였다.'
---

다양한 런타임(Java, Python, Nodejs)로 어플리케이션이 쿠버네티스에서 실행 중일 때, Log, Trace, Metric을 어떻게 수집하면 좋을까? [OpenTelmetry Operator](https://opentelemetry.io/docs/kubernetes/operator/)를 사용하는 것을 생각해볼 수 있다. 어플리케이션 코드를 수정하지 않고 `Instrumentation CRD`를 통해서 자동으로 instrumentation을 할 수 있다. 이번 블로그에서는 Python에서 OpenTelemetry를 통해서 로그를 수집하는 것에 대해서 집중적으로 살펴 본다.

## Helm Chart로 설치

[cert-manager](https://cert-manager.io/)를 먼저 설치하고, Helm Chart로 open-telemetry/opentelemetry-operator `0.58.2`를 설치한다.

```bash
kubecl create namespace opentelemetry-operator-system
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update
helm install opentelemetry-operator open-telemetry/opentelemetry-operator \
--namespace opentelemetry-operator-system
```

## OpenTelemetry Collector 설치

`OpenTelemetry Operator`로 Collector를 설정할 수 있지만, Helm Chart로 별도로 실행하면 아래와 같이 values를 정의할 수 있다. 추가적으로 `Loki`를 통해서 Log를 수집하도록 설정하였다. [Loki의 문서를 보면 OTLP 프로토콜로 Log를 수집하는 방법](https://grafana.com/docs/loki/latest/send-data/otel/)도 설명하고 있는데, 여기서는 [Loki Exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/lokiexporter/README.md)를 사용했다. Loki Exporter의 `default_labels_enabled` 설정을 통해서 기본적인 Loki Label(Index)를 추가하도록 했다. 그리고 `Instrumentation CRD`를 통해서 OpenTelemetry Instrumentation을 자동으로 할 때 생성되는 resources 값들을 Loki label로 추가하도록 [Resource Processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/resourceprocessor/README.md)를 사용하였다.

`values.yml`

```yaml
config:
  receivers:
    jaeger: null
    prometheus: null
    zipkin: null
  service:
    telemetry:
      logs:
        level: info
    pipelines:
      traces:
        receivers:
          - otlp
      metrics:
        receivers:
          - otlp
      logs:
        receivers:
          - otlp
        processors:
          - resource
        exporters:
          - loki
  processors:
    resource:
      attributes:
        - action: insert
          key: pod
          from_attribute: k8s.pod.name
        - action: insert
          key: container
          from_attribute: k8s.container.name
        - action: insert
          key: namespace
          from_attribute: k8s.namespace.name
        - action: insert
          key: loki.resource.labels
          value: pod, namespace, container
  exporters:
    loki:
      endpoint: http://loki-gateway/loki/api/v1/push
      default_labels_enabled:
        exporter: true
        job: true
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
    enabled: false
    includeCollectorLogs: false
```

위에서 OpenTelemetry Collector를 DaemonSet으로 실행하도록 설정하였다. Service는 [internalTrafficPolicy](https://kubernetes.io/docs/concepts/services-networking/service-traffic-policy/#using-service-internal-traffic-policy)를 통해서 같은 Node에 있는 OpenTelmetry Colletor endpoint에 접근하도록 설정했다. 그리고 다른 Namespace에 있는 Service에 접근하기 위해서 `ExternalName`으로 서비스를 추가하였다.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: otel-collector
  namespace: opentelemetry
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: opentelemetry-collector
  ports:
    - name: http
      port: 4318
      targetPort: 4318
    - name: grpc
      port: 4317
      targetPort: 4317
  internalTrafficPolicy: Local
---
apiVersion: v1
kind: Service
metadata:
  name: otel-collector
  namespace: example
spec:
  type: ExternalName
  externalName: otel-collector.opentelemetry.svc.cluster.local
```

## Instrumentation CRD 생성

[공식 문서에서 Python의 경우 어떻게 Instrumentation CRD를 생성해야할지 잘 설명하고 있다.](https://opentelemetry.io/docs/kubernetes/operator/automatic/#python) 아래와 같이 Python에 대해서 설정을 하여 Instrumentation를 생성한다.

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: python-instrumentation
spec:
  exporter:
    endpoint: http://otel-collector:4318
  env:
  propagators:
    - tracecontext
    - baggage
  python:
    env:
      - name: OTEL_LOGS_EXPORTER
        value: console
      - name: OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED
        value: 'true'
```

[이 글을 쓰는 시점에서 Python Otel SDK libary중에 Logs는 Experimental 상태이다.](https://opentelemetry.io/docs/languages/python/).

<img src="/static/images/otel-python-logs-status.png" alt="OpenTelemetry Python Logs Status" />

따라서 logs는 기본적으로 사용하지 않게 되어 있는데, 사용하려면 아래와 같이 `환경변수를 꼭 설정해줘야 한다`. `OTEL_LOGS_EXPORTER`를 `console`로 설정하여 OpenTelemetry Collector에 보내기 전에 로그가 잘 남고 있는지 확인하고자 한다.

```bash
By default, Python logs auto-instrumentation is disabled.
If you would like to enable this feature, you must to set the OTEL_LOGS_EXPORTER and OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED environment variables as follows
```

```yaml
python:
  env:
    - name: OTEL_LOGS_EXPORTER
      value: console
    - name: OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED
      value: 'true'
```

## Flask App에 적용

Flask Application을 실행해서 확인해보자. 아주 단순하게 `GET /hello`로 요청하면 응답하는 코드이다.

`app.py`

```py
from flask import Flask, request

app = Flask(__name__)

@app.route("/hello")
def server_request():
    print("hello world!")
    return "world!"

if __name__ == "__main__":
    app.run(port=5000)
```

Python package는 `flask`만 설치하도록 한다.

`requirements.txt`

```txt
flask
```

쿠버네티스에서 실행하기 위해서 Container Image를 생성한다.

`Dockerfile`

```Dockerfile
FROM --platform=linux/amd64 python:3.11
WORKDIR /usr/src/app
COPY requirements.txt requirements.txt
RUN pip3 install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python", "-m", "flask", "--app", "app", "run"]
```

Dockerfile로 빌드한 컨테이너 이미지를 쿠버네티스에 배포한다. 이때 Annotation을 통해서 auto instrumentation이 될 수 있도록 설정한다.

`deployment.yml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sample
spec:
  selector:
    matchLabels:
      app: sample
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-python: 'true'
      labels:
        app: sample
    spec:
      containers:
        - image: sample
          name: sample
          imagePullPolicy: Always
```

그럼 이제 해당 Conatiner에 터미널 접속해서 curl로 요청을 해본다.

```bash
curl localhost:5000/hello
```

이제 `kubectl logs`로 해당 컨테이너의 log를 확인해보면 아래와 같이 남는 것을 확인할 수 있다. 위세서 `Instrumentation CRD`를 생성할 때 `OTEL_LOGS_EXPORTER`를 `console`로 설정했기 때문에 이렇게 log를 확인할 수 있는 것이다.

```json
{
  "body": "127.0.0.1 - - [25/May/2024 23:02:38] \"GET /hello HTTP/1.1\" 200 -",
  "severity_number": "<SeverityNumber.INFO: 9>",
  "severity_text": "INFO",
  "attributes": {
    "otelSpanID": "0",
    "otelTraceID": "0",
    "otelTraceSampled": false,
    "otelServiceName": "sample",
    "code.filepath": "/usr/local/lib/python3.11/site-packages/werkzeug/_internal.py",
    "code.function": "_log",
    "code.lineno": 97
  },
  "dropped_attributes": 0,
  "timestamp": "2024-05-25T23:02:38.152708Z",
  "observed_timestamp": "2024-05-25T23:02:38.152765Z",
  "trace_id": "0x00000000000000000000000000000000",
  "span_id": "0x0000000000000000",
  "trace_flags": 0,
  "resource": "{'telemetry.sdk.language': 'python', 'telemetry.sdk.name': 'opentelemetry', 'telemetry.sdk.version': '1.23.0', 'k8s.container.name': 'sample', 'k8s.deployment.name': 'sample', 'k8s.namespace.name': 'example', 'k8s.node.name': 'example-node', 'k8s.pod.name': 'sample-656f58b97c-swk2p', 'k8s.replicaset.name': 'sample-656f58b97c', 'service.instance.id': 'example.sample-656f58b97c-swk2p.sample', 'service.version': 'amd64', 'service.name': 'sample', 'telemetry.auto.version': '0.44b0'}"
}
```

## Init Container 확인

배포된 Pod의 상세 정보를 보면 아래와 같이 `Init Conatiner`가 실행된 것을 확인할 수 있다.

```yaml
Init Containers:
  opentelemetry-auto-instrumentation-python:
    Container ID: containerd://2e5230382ee3a5819d349baeb65871dd368d0eaffa7b589b9c874a8b7ff5fc81
    Image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:0.44b0
    Image ID: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python@sha256:a463e65ed49d6dee2ec79b40339f802341291a4e62655d2caeded5aa1e15e8d2
    Port: <none>
    Host Port: <none>
    Command: cp
      -r
      /autoinstrumentation/.
      /otel-auto-instrumentation-python
```

Flask Application이 실행되는 Container에 자동으로 아래와 같이 환경변수가 설정되어 있다. Python OpenTelemetry SDK가 환경변수들을 통해서 설정된다.

```yaml
Containers:
  sample:
    Environment:
      OTEL_NODE_IP: (v1:status.hostIP)
      OTEL_POD_IP: (v1:status.podIP)
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_LOGS_EXPORTER: console
      OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED: true
      PYTHONPATH: /otel-auto-instrumentation-python/opentelemetry/instrumentation/auto_instrumentation:/otel-auto-instrumentation-python
      OTEL_TRACES_EXPORTER: otlp
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: http/protobuf
      OTEL_METRICS_EXPORTER: otlp
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: http/protobuf
      OTEL_SERVICE_NAME: sample
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_RESOURCE_ATTRIBUTES_POD_NAME: sample-656f58b97c-9spzq (v1:metadata.name)
      OTEL_RESOURCE_ATTRIBUTES_NODE_NAME: (v1:spec.nodeName)
      OTEL_PROPAGATORS: tracecontext,baggage
      OTEL_TRACES_SAMPLER: parentbased_traceidratio
      OTEL_TRACES_SAMPLER_ARG: 1
      OTEL_RESOURCE_ATTRIBUTES: k8s.container.name=sample,k8s.deployment.name=sample,k8s.namespace.name=example,k8s.node.name=$(OTEL_RESOURCE_ATTRIBUTES_NODE_NAME),k8s.pod.name=$(OTEL_RESOURCE_ATTRIBUTES_POD_NAME),k8s.replicaset.name=sample-656f58b97c,service.instance.id=example.$(OTEL_RESOURCE_ATTRIBUTES_POD_NAME).sample,service.version=amd64
    Mounts: /otel-auto-instrumentation-python from opentelemetry-auto-instrumentation-python (rw)
      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-49jw9 (ro)
```

그리고 Init Container를 통해서 설정된 데이터가 Mount된 것을 확인할 수 있다.

```yaml
Containers:
  sample:
    Mounts: /otel-auto-instrumentation-python from opentelemetry-auto-instrumentation-python (rw)
      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-49jw9 (ro)
```

[opentelemetry-operator에서 autoinstrumentation 소스코드](https://github.com/open-telemetry/opentelemetry-operator/blob/main/autoinstrumentation/python/Dockerfile)를 확인해보면 다양한 OpenTelemetry Instrumentation package들을 설치하는 것을 알 수 있다. Init Container에서 해당 package들을 설치하고, 설치된 package 파일들이 Mount된 경로에 저장되어 있다.

```Dockerfile
FROM python:3.11 AS build

WORKDIR /operator-build

ADD requirements.txt .

RUN mkdir workspace && pip install --target workspace -r requirements.txt

FROM busybox

COPY --from=build /operator-build/workspace /autoinstrumentation

RUN chmod -R go+r /autoinstrumentation
```

그리고 Flask Application이 실행중인 Container에 Terminal로 연결해서 확인하면 PYTHONPATH를 확인해보면, 해당 경로가 포함되어 있는 것을 확인할 수 있다. 그래서 나의 Flask 어플리케이션이 실행하는 컨테이너에서도 init Container에서 설치한 경로의 package들을 사용할 수 있다.

```bash
# export
declare -x PYTHONPATH="/otel-auto-instrumentation-python/opentelemetry/instrumentation/auto_instrumentation:/otel-auto-instrumentation-python"
```

그런데 PYTHONPATH 환경변수를 보면, Init Container에 의해서 설치되는 패키지들이 있는 `otel-auto-instrumentation-python` 경로 말고 아래의 경로가 보인다.

```bash
/otel-auto-instrumentation-python/opentelemetry/instrumentation/auto_instrumentation
```

해당 경로는 [소스코드처럼](https://github.com/open-telemetry/opentelemetry-python-contrib/tree/main/opentelemetry-instrumentation/src/opentelemetry/instrumentation/auto_instrumentation) `sitecustomize.py`이 있다. [Python에서 PYTHONPATH의 root 경로에 sitecustomize.py를 추가하면 자동으로 import를 할 수 있다.](https://docs.python.org/3/library/site.html#module-sitecustomize) [이 블로그에서는 아래처럼 잘 설명해주고 있다.](https://medium.com/alan/simplifying-python-workflows-with-the-sitecustomize-py-e1b1ad5c6fbe)

> If you configure the PYTHONPATH=. environment variable, any sitecustomize.py at the root of your repository will be evaluated before any application code runs.

이제 `opentelemetry-operator`가 init container를 통해서 instrumentation library들을 설치하고, Python의 `sitecustomize.py`로 자동으로 instrumentation을 하게 된다. `requirements.txt`에는 `flask`만 추가하고, 소스코드에 OpenTelemetry관련 설정 코드를 추가하지 않아도 자동으로 OpenTelemetry를 통해서 Metric, Trace, Log를 수집할 수 있다.

## Logs Bridge API

위에서 우리는 Flask 어플리케이션으로 테스트를 해봤다. 그런데 `print("hello world!")`라고 standard output으로 로그를 남기도록 작성했었다.

`app.py`

```py
from flask import Flask

app = Flask(__name__)

@app.route("/hello")
def server_request():
    app.logger.info('hello from logger!')
    print("hello world!")
    return "world!"

if __name__ == "__main__":
    app.run(port=5000)
```

그런데 `kubectl logs`로 확인을 해보면 해당 로그는 OpenTelmetry Spec에 맞춰서 남고 있지 않는 것을 확인할 수 있다. 왜 이렇게 남을까? 🤔

```bash
hello world!
hello world!
hello world!
{
    "body": "127.0.0.1 - - [25/May/2024 23:02:36] \"GET /hello HTTP/1.1\" 200 -",
    "severity_number": "<SeverityNumber.INFO: 9>",
    "severity_text": "INFO",
    "attributes": {
        "otelSpanID": "0",
        "otelTraceID": "0",
        "otelTraceSampled": false,
        "otelServiceName": "sample",
        "code.filepath": "/usr/local/lib/python3.11/site-packages/werkzeug/_internal.py",
        "code.function": "_log",
        "code.lineno": 97
    },
    "dropped_attributes": 0,
    "timestamp": "2024-05-23T25:02:36.856645Z",
    "observed_timestamp": "2024-05-25T23:02:36.856694Z",
    "trace_id": "0x00000000000000000000000000000000",
    "span_id": "0x0000000000000000",
    "trace_flags": 0,
    "resource": "{'telemetry.sdk.language': 'python', 'telemetry.sdk.name': 'opentelemetry', 'telemetry.sdk.version': '1.23.0', 'k8s.container.name': 'sample', 'k8s.deployment.name': 'sample', 'k8s.namespace.name': 'example', 'k8s.node.name': 'example-node', 'k8s.pod.name': 'sample-656f58b97c-swk2p', 'k8s.replicaset.name': 'sample-656f58b97c', 'service.instance.id': 'example.sample-656f58b97c-swk2p.sample', 'service.version': 'amd64', 'service.name': 'sample', 'telemetry.auto.version': '0.44b0'}"
}
```

[OpenTelemetry 공식문서에서 Logging은 어떤식으로 설계했는지 친절하게 설명](https://opentelemetry.io/docs/specs/otel/logs/)이 되어 있다. 이미 Logging 관련한 다양한 라이브러리가 존재하는데, 기존 Logging 라이브러리를 사용해서 OpenTelemetry 로그를 남길 수 있도록 아래와 같은 구조로 되어 있다.

<img src="/static/images/otel-logs-bridge-api.png" alt="OpenTelemetry logs bridge API" />

> Instead of modifying each logging statement, log appenders use the API to bridge logs from existing logging libraries to the OpenTelemetry data model, where the SDK controls how the logs are processed and exported.

Flask에서는 Python standard library인 `logging`을 사용하고, 아래와 같이 로그를 남긴다. 그런데 해당 logging 라이브러리가 OpenTelemetry Bridge API를 통해서 OpenTelemetry 규격에 많은 로그가 남게 되는 것이다. 하지만 `print`를 사용했을 때는 이러한 구조로 연결되어 있지 않기 때문에 단순 stdout으로 남는다.

```bash
127.0.0.1 - - [25/May/2024 23:02:36] \"GET /hello HTTP/1.1\" 200 -
```

[opentelemetry-sdk 소스코드를 보면](https://github.com/open-telemetry/opentelemetry-python/blob/187048a35ee93194a70a45720fa68b78d57b6a97/opentelemetry-sdk/src/opentelemetry/sdk/_configuration/__init__.py#L388) 아래와 같이 handler가 추가되는 것을 확인할 수 있다. 환경변수를 `true`로 설정하지 않으면 해당 `_init_logging`가 실행되지 않는다.

```py
logging_enabled = os.getenv(
    _OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED, "false"
)
if logging_enabled.strip().lower() == "true":
    _init_logging(log_exporters, resource)
```

```py
def _init_logging(
    exporters: Dict[str, Type[LogExporter]],
    resource: Resource = None,
):
    provider = LoggerProvider(resource=resource)
    set_logger_provider(provider)

    for _, exporter_class in exporters.items():
        exporter_args = {}
        provider.add_log_record_processor(
            BatchLogRecordProcessor(exporter_class(**exporter_args))
        )

    handler = LoggingHandler(level=logging.NOTSET, logger_provider=provider)

    logging.getLogger().addHandler(handler)
```

## Manual하게 Logging 설정

위의 코드를 이해하기 위해서 메뉴얼하게 Python Logger 라이브러리에 OpenTelemetry sdk로 log를 보내도록 handler를 추가하면 아래 코드와 같다.

`app.py`

```py
import logging, os
from flask import Flask, request
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource

logger_provider = LoggerProvider(
    resource=Resource.create(
        {
            "service.name": "example",
            "service.instance.id": os.uname().nodename,
        }
    ),
)
set_logger_provider(logger_provider)
otlp_exporter = OTLPLogExporter(endpoint="http://otel-collector:4318/v1/logs")
logger_provider.add_log_record_processor(BatchLogRecordProcessor(otlp_exporter))
handler = LoggingHandler(level=logging.DEBUG, logger_provider=logger_provider)
logging.getLogger().addHandler(handler)

app = Flask(__name__)
app.logger.setLevel(logging.INFO)

@app.route("/hello")
def server_request():
    app.logger.info('hello from logger!')
    print("hello world!")
    return "world!"

if __name__ == "__main__":
    app.run(port=5000)
```

`requirements.txt`

```
flask
opentelemetry-distro
opentelemetry-instrumentation-fastapi
opentelemetry-instrumentation-logging
opentelemetry-exporter-otlp-proto-http
```

`Dockerfile`

```Dockerfile
FROM --platform=linux/amd64 python:3.11
WORKDIR /usr/src/app
COPY requirements.txt requirements.txt
RUN pip3 install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python", "-m", "flask", "--app", "app", "run"]
```

그리고 이제 auto instrumentation이 되지 않도록 annotation을 제거하고, Container Image를 배포한다. `opentelemetry-operator`에 의해서 자동으로 주입된 환경변수도 수동으로 넣어주었다.

`deployment.yml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sample
spec:
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app: sample
  template:
    metadata:
      labels:
        app: sample
    spec:
      containers:
        - image: sample
          name: sample
          imagePullPolicy: Always
          env:
            - name: OTEL_SERVICE_NAME
              value: example
            - name: OTEL_EXPORTER_OTLP_PROTOCOL
              value: http/protobuf
            - name: OTEL_LOGS_EXPORTER
              value: otlp_proto_http
            - name: OTEL_TRACES_EXPORTER
              value: otlp
            - name: OTEL_METRICS_EXPORTER
              value: otlp
            - name: OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED
              value: 'true'
            - name: OTEL_RESOURCE_ATTRIBUTES_POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: OTEL_RESOURCE_ATTRIBUTES_NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: 'k8s.container.name=sample,k8s.deployment.name=sample,k8s.namespace.name=example,k8s.node.name=$(OTEL_RESOURCE_ATTRIBUTES_NODE_NAME),k8s.pod.name=$(OTEL_RESOURCE_ATTRIBUTES_POD_NAME),k8s.replicaset.name=sample-55c69d6957,service.instance.id=example.$(OTEL_RESOURCE_ATTRIBUTES_POD_NAME).sample,service.version=latest'
```

이렇게 배포하고 동일하게 Flask Application에 요청을 하면 동일한 로그가 남는 것을 확인할 수 있다. (하지만 Trace에 대해서는 설정을 하지 않았기 때문에 해당 Log에 TraceID와 SpanID는 추가되지 않는다.)

[그리고 위에서 Exporter를 grpc대신에 http를 사용했는데, opentelemetry operater에서는 grpc가 OS와 Python version에 의존성이 있기 때문에 범용적으로 사용할 수 있는 http를 사용한다.](https://github.com/open-telemetry/opentelemetry-operator/blob/main/autoinstrumentation/python/requirements.txt)

```bash
# We don't use the distro[otlp] option which automatically includes exporters since gRPC is not appropriate for
# injected auto-instrumentation, where it has a strict dependency on the OS / Python version the artifact is built for.
opentelemetry-exporter-otlp-proto-http==1.23.0
```

## Loki로 확인

이번에는 `OTEL_LOGS_EXPORTER`를 `otlp_proto_http`로 설정하여 OpenTelemetry Collector가 로그를 수집하도록 한다. 그리고 위에서 OpenTelemetry Collector에서 Loki Exporter를 설정하였기 때문에, 정상적으로 Loki에 로그가 쌓이는지 확인해본다.

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: python-instrumentation
spec:
  exporter:
    endpoint: http://otel-collector:4318
  env:
  propagators:
    - tracecontext
    - baggage
  python:
    env:
      - name: OTEL_LOGS_EXPORTER
        value: otlp_proto_http
      - name: OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED
        value: 'true'
```

수정한 `Instrumentation CRD`를 배포하고, 다시 Flask 어플리케이션 Container가 있는 Pod를 재시작하면 아래와 같이 Loki에 로그가 쌓이는 것을 확인할 수 있다.

```json
{
  "body": "127.0.0.1 - - [25/May/2024 01:49:05] \"GET /hello HTTP/1.1\" 200 -",
  "severity": "INFO",
  "attributes": {
    "code.filepath": "/usr/local/lib/python3.11/site-packages/werkzeug/_internal.py",
    "code.function": "_log",
    "code.lineno": 97,
    "otelServiceName": "sample",
    "otelSpanID": "0",
    "otelTraceID": "0",
    "otelTraceSampled": false
  },
  "resources": {
    "k8s.container.name": "sample",
    "k8s.deployment.name": "sample",
    "k8s.namespace.name": "example",
    "k8s.node.name": "example-node",
    "k8s.pod.name": "sample-656f58b97c-9mr6d",
    "k8s.replicaset.name": "sample-656f58b97c",
    "service.instance.id": "example.sample-656f58b97c-9mr6d.sample",
    "service.name": "sample",
    "service.version": "amd64",
    "telemetry.auto.version": "0.44b0",
    "telemetry.sdk.language": "python",
    "telemetry.sdk.name": "opentelemetry",
    "telemetry.sdk.version": "1.23.0"
  },
  "instrumentation_scope": {
    "name": "opentelemetry.sdk._logs._internal"
  }
}
```

resources에 저렇게 남기 때문에, opentelemetry collector 설정에 resource processors를 아래와 같이 정의해서 Loki label를 추가하였다.

```yaml
processors:
  resource:
    attributes:
      - action: insert
        key: pod
        from_attribute: k8s.pod.name
      - action: insert
        key: container
        from_attribute: k8s.container.name
      - action: insert
        key: namespace
        from_attribute: k8s.namespace.name
      - action: insert
        key: loki.resource.labels
        value: pod, namespace, container
```

## Gunicorn으로 실행

Flask Production에서 실행할 때는 Flask의 개발용 WSGI server를 사용하지 않고 별도의 WSGI server를 사용한다. Gunicorn을 사용하면 아래와 같이 설정이 된다.

`app.py`

```py
import logging
from flask import Flask, request

app = Flask(__name__)
app.logger.setLevel(logging.INFO)

@app.route("/hello")
def hello():
    app.logger.info("hello world!")
    return "world!"

@app.route("/error")
def error():
    app.logger.info("error test!")
    raise Exception("test exception")
    return "world!"


if __name__ == "__main__":
    app.run(port=5000)
```

`requirements.txt`

```txt
flask
gunicorn
```

`Dockerfile`

```Dockerfile
FROM --platform=linux/amd64 python:3.11
WORKDIR /usr/src/app
COPY requirements.txt requirements.txt
RUN pip3 install --no-cache-dir -r requirements.txt
COPY . .
CMD [ "python3", "-m" , "gunicorn", "app:app"]
```

정상적으로 로그들이 수집되는 것을 확인했다.

## FastAPI Uvicorn 실행

Python에서 Web Application을 만들 때, FastAPI도 많이 쓴다. 따라서 FastAPI를 ASGI Server인 Uvicorn으로 실행하여 Log 수집을 확인해봤다. 아래와 같이 Sample 코드를 동일하게 작성하여 Info 로그와 Error 로그가 잘 수집되는 것을 확인하였다.

`app.py`

```py
import logging
from typing import Union
from fastapi import FastAPI

app = FastAPI()
logger = logging.getLogger()
logger.setLevel(logging.INFO)

@app.get("/hello")
def hello():
    logger.info('hello uvicorn!')
    return {"Hello": "World"}

@app.get("/error")
def error():
    logger.info('error test')
    raise Exception("test exception")
    return {"Hello": "World"}
```

`requirements.txt`

```
fastapi
pydantic
```

`Dockerfile`

```Dockerfile
FROM --platform=linux/amd64 python:3.11
WORKDIR /usr/src/app
COPY requirements.txt requirements.txt
RUN pip3 install --no-cache-dir -r requirements.txt
COPY . .
CMD ["uvicorn", "app:app", "--host=0.0.0.0"]
```

## Multi Process

Python은 GIL때문에 CPU Core가 여러 개일때 Process를 늘리는 방식을 사용한다. Kuberentes에서 CPU는 하나만 할당하고 Scale out을 하는 경우에는 괜찮겠지만, 멀티 코어에 멀티 프로세스로 운영할 때는 Auto Instrumentation을 사용할 수 없는 것으로 보인다.

[그리고 default으로 설정되는 BatchSpanProcessor의 경우에는 Gunicorn처럼 pre-fork를 해서 사용할 문제가 발생할수 있다고 문서에 설명하고 있다.](https://opentelemetry-python.readthedocs.io/en/latest/examples/fork-process-model/README.html) 그래서 Gunicorn의 `post_fork` Hook을 사용하여 설정하는 것을 고려해야 한다.

gunicorn.conf.py

```py
def post_fork(server, worker):
```

## 결론

OpenTelemetry Operator의 Instrumentation CRD를 통해서 나의 어플리케이션의 소스코드 변경없이 자동으로 Instrumentation 할 수가 있다. 다양한 Instrumentation Library를 통해서 Trace, Metric, Logging등을 자동으로 수집할 수 있다. 이번에는 특히 Python Runtime 경우에 OpenTelemetry Operator로 어떻게 Logging이 자동으로 될 수 있는지 확인해보았다. Init Container로 다양한 instrumentation library와 sdk/api library를 설치하고, mount한 해당 volume 경로를 PYTHONPATH에 추가한다. 그리고 PYTHONPATH에 opentelemetry-instrumentation 라이브러리의 sitecustomize.py가 나의 Python 어플리케이션이 실행되기 전에 import되도록 설정한다. 그래서 instrumentation library이 자동으로 설정될 수 있다. 주입된 환경변수와 함께 opentelemetry sdk가 Metric, Trace, Logging 설정을 하고, 최종적으로 OpenTelemetry Collector로 해당 데이터를 보내게 된다.
