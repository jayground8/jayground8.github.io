---
title: 'Google Cloud Exporter가 Log의 Resource Attribute를 Cloud Logging Label로 어떻게 변환할까?'
date: '2025-01-25'
tags: ['gcp', 'kubernetes', 'opentelemetry']
images: ['/static/images/social-banner.png']
summary: 'OpenTelemetry Collector를 사용할 때, 다양한 exporter를 통해서 Telemetry data를 저장할 수 있다. GCP를 사용하는 경우에는 Google Cloud Exporter를 사용해서 Telemetry data를 쉽게 저장할 수 있다. 그런데 Log의 경우에는 내가 설정한 Resource attribute가 기대한 것처럼 Google Cloud Logging의 Label에 등록되지 않는 경우를 경험할 수도 있다. 따라서 오늘은 Google Cloud Exporter를 사용할 때, Resource Attribute들이 Cloud Logging Label로 어떻게 변환되는지 자세히 설명한다.'
---

OpenTelemetry Collector를 사용할 때, 다양한 exporter를 통해서 Telemetry data를 저장할 수 있다. GCP를 사용하는 경우에는 [Google Cloud Exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/googlecloudexporter/README.md)를 사용해서 Telemetry data를 쉽게 저장할 수 있다. 그런데 Log의 경우에는 내가 설정한 Resource attribute가 기대한 것처럼 Google Cloud Logging의 Label에 등록되지 않는 경우를 경험할 수 있다. 오늘은 Google Cloud Exporter를 사용할 때, Resource Attribute들이 Cloud Logging Label로 어떻게 변환되는지 자세히 설명한다.

## 예제

환경

- GKE
- Python / FastApi
- OpenTelemetry Collector로 Telemetry data 수집

### 컨테이너 이미지 빌드

먼저 예제로 사용할 Python Application을 Container Image로 빌드한다.

`app/main.py`

```python
import logging
from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (
    OTLPMetricExporter,
)
from opentelemetry._logs import set_logger_provider
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.sdk.resources import get_aggregated_resources
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

trace.set_tracer_provider(TracerProvider())
tracer = trace.get_tracer(__name__)
trace.get_tracer_provider().add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(insecure=True))
)
exporter = OTLPMetricExporter(insecure=True)
reader = PeriodicExportingMetricReader(exporter)
provider = MeterProvider(, metric_readers=[reader])
metrics.set_meter_provider(provider)
meter = metrics.get_meter_provider().get_meter("test")

logger_provider = LoggerProvider()
set_logger_provider(logger_provider)
logger_provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter(insecure=True)))
handler = LoggingHandler(level=logging.NOTSET, logger_provider=logger_provider)

app = FastAPI()
logging.basicConfig(level=logging.DEBUG)
logging.getLogger().addHandler(handler)
logging.getLogger("uvicorn.access").addHandler(handler)
logging.getLogger("uvicorn.error").addHandler(handler)
logger = logging.getLogger(__name__)
counter = meter.create_counter("counter")

@app.get("/")
async def root():
    logger.info("Hello World")
    counter.add(1)
    return {"message": "Hello World"}

FastAPIInstrumentor.instrument_app(app)
```

`requirements.txt`

```
fastapi
uvicorn[standard]
opentelemetry-api
opentelemetry-sdk
opentelemetry.instrumentation.fastapi
opentelemetry-exporter-otlp-proto-grpc
opentelemetry-resourcedetector-gcp
```

`Dockerfile`

```Dockerfile
FROM debian:12-slim AS build
RUN apt-get update && \
    apt-get install --no-install-suggests --no-install-recommends --yes python3-venv gcc libpython3-dev && \
    python3 -m venv /venv && \
    /venv/bin/pip install --upgrade pip setuptools wheel

FROM build AS build-venv
COPY requirements.txt /requirements.txt
RUN /venv/bin/pip install --disable-pip-version-check --default-timeout=100 -r /requirements.txt

FROM gcr.io/distroless/python3-debian12:debug-nonroot
COPY --from=build-venv /venv /venv
COPY /app /app
WORKDIR /app

ENTRYPOINT ["/venv/bin/python3", "-m", "uvicorn", "main:app", "--host",  "0.0.0.0"]
```

### 쿠버네티스에 배포

kubectl cli로 Service와 Pod를 배포한다.

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: sample
  labels:
    app: sample
spec:
  containers:
  - name: sample
    image: sample
    imagePullPolicy: Always
    env:
      - name: OTEL_EXPORTER_OTLP_PROTOCOL
        value: grpc
      - name: OTEL_EXPORTER_OTLP_ENDPOINT
        value: "http://otel-collector:4317"
      - name: OTEL_SERVICE_NAME
        value: sample
      - name: OTEL_RESOURCE_ATTRIBUTES
        value: k8s.container.name=sample,k8s.namespace.name=tutorial
    ports:
      - name: container-port
        containerPort: 8000
---

apiVersion: v1
kind: Service
metadata:
  name: sample
spec:
  type: ClusterIP
  selector:
    app: sample
  ports:
    - name: service-port
      port: 80
      targetPort: container-port
EOF
```

### Cloud Logging 확인

GCP Console에서 아래와 같이 OpenTelemetry에 의해서 쌓인 로그 데이터를 확인할 수 있다.

<img src="/static/images/cloud-logging.png" alt="Cloud Logs Explorer" />

그런데 데이터의 label을 확인하면, 아래와 같이 남는다.

```json
{
  "resource": {
    "type": "generic_node",
    "labels": {
      "namespace": "",
      "project_id": "my-prj",
      "location": "global",
      "node_id": ""
    }
  }
}
```

Application에서 OpenTelemetry SDK를 통해서 Resource Attribute를 아래와 같이 설정하고 있다. 그런데 k8s.namespace.name에 의해서 Cloud Logging label에 해당 값이 반영될거라 기대했겠지만, 빈문자열로 나온다.

```json
{
  "resource": {
    "attributes": {
      "telemetry.sdk.language": "python",
      "telemetry.sdk.name": "opentelemetry",
      "telemetry.sdk.version": "1.29.0",
      "k8s.container.name": "sample",
      "k8s.namespace.name": "tutorial",
      "service.name": "sample"
    },
    "schema_url": ""
  }
}
```

### Resource Detector 설정

위에서 namespace, container 이름들이 Cloud Logging label에 남지 않는 것을 확인하였다. `main.py` 샘플 코드에 아래와 같이 GoogleCloudResourceDetector를 통해서 Resource를 초기화하도록 변경한다.

```python
from opentelemetry.resourcedetector.gcp_resource_detector import (
    GoogleCloudResourceDetector,
)
resource = get_aggregated_resources(
    [GoogleCloudResourceDetector(raise_on_error=True)]
)
logger_provider = LoggerProvider(resource=resource)
```

전체 수정된 코드는 아래와 같다.

`app/main.py`

```python
import logging
from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (
    OTLPMetricExporter,
)
from opentelemetry._logs import set_logger_provider
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.sdk._logs.export import ConsoleLogExporter
from opentelemetry.sdk.resources import get_aggregated_resources
from opentelemetry.resourcedetector.gcp_resource_detector import (
    GoogleCloudResourceDetector,
)
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

resource = get_aggregated_resources(
    [GoogleCloudResourceDetector(raise_on_error=True)]
)

trace.set_tracer_provider(TracerProvider(resource=resource))
tracer = trace.get_tracer(__name__)
trace.get_tracer_provider().add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(insecure=True))
)
exporter = OTLPMetricExporter(insecure=True)
reader = PeriodicExportingMetricReader(exporter)
provider = MeterProvider(resource=resource, metric_readers=[reader])
metrics.set_meter_provider(provider)
meter = metrics.get_meter_provider().get_meter("test")

logger_provider = LoggerProvider(resource=resource)
set_logger_provider(logger_provider)
logger_provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter(insecure=True)))
handler = LoggingHandler(level=logging.NOTSET, logger_provider=logger_provider)

app = FastAPI()
logging.basicConfig(level=logging.DEBUG)
logging.getLogger().addHandler(handler)
logging.getLogger("uvicorn.access").addHandler(handler)
logging.getLogger("uvicorn.error").addHandler(handler)
logger = logging.getLogger(__name__)
counter = meter.create_counter("counter")

@app.get("/")
async def root():
    logger.info("Hello World")
    counter.add(1)
    return {"message": "Hello World"}

FastAPIInstrumentor.instrument_app(app)
```

이제 Cloud Logging 데이터의 Label을 보면 아래와 같이 우리가 원하는 Kubernetes 관련 정보들이 남겨진 것을 확인할 수 있다.

```json
{
  "resource": {
    "type": "k8s_container",
    "labels": {
      "project_id": "my-prj",
      "container_name": "sample",
      "location": "",
      "pod_name": "sample",
      "cluster_name": "tutorial-cluster",
      "namespace_name": "tutorial"
    }
  }
}
```

GCP Resource Detector가 Resource Attribute들을 추가하였고, 그것이 Cloud Logging Label로 변환된 것이다. [어떻게 Label로 변환되는지 소스코드](https://github.com/GoogleCloudPlatform/opentelemetry-operations-go/blob/v0.49.0/internal/resourcemapping/resourcemapping.go)을 살펴보자. 우리가 눈여겨 봐야할 부분은 아래와 같다.

```go
// ResourceAttributesToLoggingMonitoredResource converts from a set of OTEL resource attributes into a
// GCP monitored resource type and label set for Cloud Logging.
// E.g.
// This may output `gce_instance` type with appropriate labels.
func ResourceAttributesToLoggingMonitoredResource(attrs ReadOnlyAttributes) *monitoredrespb.MonitoredResource {
	cloudPlatform, _ := attrs.GetString(string(semconv.CloudPlatformKey))
	switch cloudPlatform {
	case semconv.CloudPlatformGCPAppEngine.Value.AsString():
		return createMonitoredResource(gaeApp, attrs)
	default:
		return commonResourceAttributesToMonitoredResource(cloudPlatform, attrs)
	}
}

func commonResourceAttributesToMonitoredResource(cloudPlatform string, attrs ReadOnlyAttributes) *monitoredrespb.MonitoredResource {
	switch cloudPlatform {
	case semconv.CloudPlatformGCPComputeEngine.Value.AsString():
		return createMonitoredResource(gceInstance, attrs)
	case semconv.CloudPlatformAWSEC2.Value.AsString():
		return createMonitoredResource(awsEc2Instance, attrs)
	// TODO(alex-basinov): replace this string literal with semconv.CloudPlatformGCPBareMetalSolution
	// once https://github.com/open-telemetry/semantic-conventions/pull/64 makes its way
	// into the semconv module.
	case "gcp_bare_metal_solution":
		return createMonitoredResource(bmsInstance, attrs)
	default:
		// if k8s.cluster.name is set, pattern match for various k8s resources.
		// this will also match non-cloud k8s platforms like minikube.
		if _, ok := attrs.GetString(string(semconv.K8SClusterNameKey)); ok {
			// Try for most to least specific k8s_container, k8s_pod, etc
			if _, ok := attrs.GetString(string(semconv.K8SContainerNameKey)); ok {
				return createMonitoredResource(k8sContainer, attrs)
			} else if _, ok := attrs.GetString(string(semconv.K8SPodNameKey)); ok {
				return createMonitoredResource(k8sPod, attrs)
			} else if _, ok := attrs.GetString(string(semconv.K8SNodeNameKey)); ok {
				return createMonitoredResource(k8sNode, attrs)
			}
			return createMonitoredResource(k8sCluster, attrs)
		}

		// Fallback to generic_task
		_, hasServiceName := attrs.GetString(string(semconv.ServiceNameKey))
		_, hasFaaSName := attrs.GetString(string(semconv.FaaSNameKey))
		_, hasServiceInstanceID := attrs.GetString(string(semconv.ServiceInstanceIDKey))
		_, hasFaaSInstance := attrs.GetString(string(semconv.FaaSInstanceKey))
		if (hasServiceName && hasServiceInstanceID) || (hasFaaSInstance && hasFaaSName) {
			return createMonitoredResource(genericTask, attrs)
		}

		// Everything else fallback to generic_node
		return createMonitoredResource(genericNode, attrs)
	}
}
```

조건문에서 `k8s.cluster.name`이 Resource Attribute에 있는지 확인한다. GCP Resource Detector를 설정하지 않았을 때는 `k8s.cluster.name`이 Resource Attribute에 설정되지 않았다.

```go
if _, ok := attrs.GetString(string(semconv.K8SClusterNameKey)); ok {
```

따라서 이 조건문은 실행되지 못하고, 최종적으로 아래와 같이 return 된다.

```go
return createMonitoredResource(genericNode, attrs)
```

우리가 위에서 GCP Resource Dectector가 설정되지 않았을 때 남은 label를 다시 살펴보자. `type`을 보면 generic_node인 것을 확인할 수 있는데, 위에서 함수가 Return 될 때 genericNode가 인자로 호출 되었다.

```json
{
  "resource": {
    "type": "generic_node",
    "labels": {
      "namespace": "",
      "project_id": "my-prj",
      "location": "global",
      "node_id": ""
    }
  }
}
```

그럼 GCP Resource Detector를 설정했을 때의 label 정보를 다시 확인해보자. `k8s.container.name`도 Resource Attribute에 있었기 때문에, 아래와 같이 `type`이 k8s_container로 설정된 것을 확인할 수 있다.

```json
{
  "resource": {
    "type": "k8s_container",
    "labels": {
      "project_id": "my-prj",
      "container_name": "sample",
      "location": "",
      "pod_name": "sample",
      "cluster_name": "tutorial-cluster",
      "namespace_name": "tutorial"
    }
  }
}
```

해당 인자가 어떤 것인지에 따라서 label로 변환할 Resource Attribute key가 결정이 된다. `k8sContainer`로 인자와 함께 호출되었기 때문에, Kubernetes 관련한 Resource Attribute들이 Label로 변환될 수 있었던 것이다.

```go
var (
	// monitoredResourceMappings contains mappings of GCM resource label keys onto mapping config from OTel
	// resource for a given monitored resource type.
	monitoredResourceMappings = map[string]map[string]struct {
		// If none of the otelKeys are present in the Resource, fallback to this literal value
		fallbackLiteral string
		// OTel resource keys to try and populate the resource label from. For entries with
		// multiple OTel resource keys, the keys' values will be coalesced in order until there
		// is a non-empty value.
		otelKeys []string
	}{
		gceInstance: {
			zone:       {otelKeys: []string{string(semconv.CloudAvailabilityZoneKey)}},
			instanceID: {otelKeys: []string{string(semconv.HostIDKey)}},
		},
		k8sContainer: {
			location: {otelKeys: []string{
				string(semconv.CloudAvailabilityZoneKey),
				string(semconv.CloudRegionKey),
			}},
			clusterName:   {otelKeys: []string{string(semconv.K8SClusterNameKey)}},
			namespaceName: {otelKeys: []string{string(semconv.K8SNamespaceNameKey)}},
			podName:       {otelKeys: []string{string(semconv.K8SPodNameKey)}},
			containerName: {otelKeys: []string{string(semconv.K8SContainerNameKey)}},
		},
		k8sPod: {
			location: {otelKeys: []string{
				string(semconv.CloudAvailabilityZoneKey),
				string(semconv.CloudRegionKey),
			}},
			clusterName:   {otelKeys: []string{string(semconv.K8SClusterNameKey)}},
			namespaceName: {otelKeys: []string{string(semconv.K8SNamespaceNameKey)}},
			podName:       {otelKeys: []string{string(semconv.K8SPodNameKey)}},
		},
		k8sNode: {
			location: {otelKeys: []string{
				string(semconv.CloudAvailabilityZoneKey),
				string(semconv.CloudRegionKey),
			}},
			clusterName: {otelKeys: []string{string(semconv.K8SClusterNameKey)}},
			nodeName:    {otelKeys: []string{string(semconv.K8SNodeNameKey)}},
		},
		k8sCluster: {
			location: {otelKeys: []string{
				string(semconv.CloudAvailabilityZoneKey),
				string(semconv.CloudRegionKey),
			}},
			clusterName: {otelKeys: []string{string(semconv.K8SClusterNameKey)}},
		},
		gaeInstance: {
			location: {otelKeys: []string{
				string(semconv.CloudAvailabilityZoneKey),
				string(semconv.CloudRegionKey),
			}},
			gaeModuleID:  {otelKeys: []string{string(semconv.FaaSNameKey)}},
			gaeVersionID: {otelKeys: []string{string(semconv.FaaSVersionKey)}},
			instanceID:   {otelKeys: []string{string(semconv.FaaSInstanceKey)}},
		},
		gaeApp: {
			location: {otelKeys: []string{
				string(semconv.CloudAvailabilityZoneKey),
				string(semconv.CloudRegionKey),
			}},
			gaeModuleID:  {otelKeys: []string{string(semconv.FaaSNameKey)}},
			gaeVersionID: {otelKeys: []string{string(semconv.FaaSVersionKey)}},
		},
		awsEc2Instance: {
			instanceID: {otelKeys: []string{string(semconv.HostIDKey)}},
			region: {
				otelKeys: []string{
					string(semconv.CloudAvailabilityZoneKey),
					string(semconv.CloudRegionKey),
				},
			},
			awsAccount: {otelKeys: []string{string(semconv.CloudAccountIDKey)}},
		},
		bmsInstance: {
			location:   {otelKeys: []string{string(semconv.CloudRegionKey)}},
			instanceID: {otelKeys: []string{string(semconv.HostIDKey)}},
		},
		genericTask: {
			location: {
				otelKeys: []string{
					string(semconv.CloudAvailabilityZoneKey),
					string(semconv.CloudRegionKey),
				},
				fallbackLiteral: "global",
			},
			namespace: {otelKeys: []string{string(semconv.ServiceNamespaceKey)}},
			job:       {otelKeys: []string{string(semconv.ServiceNameKey), string(semconv.FaaSNameKey)}},
			taskID:    {otelKeys: []string{string(semconv.ServiceInstanceIDKey), string(semconv.FaaSInstanceKey)}},
		},
		genericNode: {
			location: {
				otelKeys: []string{
					string(semconv.CloudAvailabilityZoneKey),
					string(semconv.CloudRegionKey),
				},
				fallbackLiteral: "global",
			},
			namespace: {otelKeys: []string{string(semconv.ServiceNamespaceKey)}},
			nodeID:    {otelKeys: []string{string(semconv.HostIDKey), string(semconv.HostNameKey)}},
		},
	}
)
```

## 해결 방법

Google Cloud Exporter를 사용하여 Cloud Monitoring Service에 Log를 남길 때, Resource Attribute들이 어떻게 Cloud Log의 Label로 변환되는지 소스코드로 이해했다. 우리는 Kubernetes의 기본적인 정보들을 Label로 전환하기 위하여, GCP Resource Detector를 사용했다. 예제에서는 Python 코드에 직접 GCP Resource Detector를 추가하여 `k8s.cluster.name`를 포함하여 필요한 여러가지 Resource Attribute를 설정하도록 하였다.

OpenTelemetry Collector를 사용하는 경우에는 소소코드를 수정하지 않고, 필요한 Resource Attribute를 추가할 수 있다. 아래와 같이 Processor에 resourcedetection을 추가하여 OpenTelemetry Collector가 Resource Attribute를 추가하도록 설정하면 된다. GKE가 아니라 다른 환경에서 사용한 Container Image를 사용한다면, 코드 변경 없이 OpenTelemetry Collector단에서 필요한 Resource Attribute를 추가하면 된다.

```yaml
processors:
	resourcedetection:
	detectors: [gcp]
	timeout: 10s

service:
  pipelines:
    logs:
		exporters:
		- googlecloud
		processors:
		- k8sattributes
		- memory_limiter
		- resourcedetection
		- batch
		receivers:
		- otlp
```

아니면 환경변수 `OTEL_RESOURCE_ATTRIBUTES`를 통해서 `k8s.cluster.name`과 더불어 필요한 Kubernetes Resource Attribute 정보들을 추가해도 동일한 결과를 얻을 수 있다. 물론 여러 Cluster에서 사용될 수 있는 경우라면, `k8s.cluster.name`을 수동으로 설정하는 것보다는 GCP Resource Detector로 설정하는 것이 더 바람직하다.

## Custom Resource Attribute를 Label로 추가하기

Google Cloud Exporter에서 나의 Custom Resource Attribute를 Cloud Logging의 Label에 추가할 수 있도록 아래와 같은 설정을 제공한다. 예를 들어서 `main.py` 코드에서 `my.attr`를 Resource Attribute로 설정한다.

```go
resource = get_aggregated_resources(
    [GoogleCloudResourceDetector(raise_on_error=True)], Resource.create({ "my.attr": "tutorial" })
)
```

Google Cloud Exporter의 설정에서 `resource_filters`를 추가하여 my를 prefix로 가지는 Resource Attribute를 Label로 추가할 수 있다. 여기서 헛갈리지 말아야할 것은 Cloud Logging의 resource.labels에 남는 것 아니라, labels에 해당 정보가 남게 된다.

```yaml
googlecloud:
	log:
		resource_filters:
			- prefix: my
```

## 결론

GKE에서 Google Cloud Export를 통해서 OpenTelemetry Log Data를 저장할 때, Resource Attribute `k8s.cluster.name`가 올바르게 설정되어야 하는 것을 알게 되었다. Resource Attribute `k8s.cluster.name`이 있을 때, Kubernetes관련 정보들이 기대하는 것처럼 Label들로 남게 된다. 수동으로 `k8s.cluster.name` 대신에 GCP Resource Detector로 자동으로 설정할 수 있다.
