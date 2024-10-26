---
title: 'Thanos Receiver의 empty attribute value 문제'
date: '2024-10-26'
tags: ['Thanos', 'opentelemetry']
images: ['/static/images/social-banner.png']
summary: 'Opentelemetry Instrumentation 라이브러리 중에서 Str(), Empty()로 attribute value를 설정하여 Metric을 보내는 경우가 있었다. 문제는 Thanos Receiver를 통해서 Metric을 저장하려고 할 때, Attribute value 값이 빈문자열이면 에러가 발생하였다. Otel 1.38.0 규격 문서를 확인했을 때 Attribute value는 빈문자열도 의미를 가질 수 있고 정상적으로 저장되어야 하는 것으로 정의되어 있었다. 따라서 Attribute value가 빈문자열이 때도 정상적으로 저장될 수 있도록 Thanos 소스코드를 수정하여 Container Image 빌드하여 사용하였다.'
---

## Attribute Value가 Str()와 Empty()

[예제 파일을 참고하여 Nodejs Application과 Python Application에서 Attribute value를 빈문자열이나 null/None 같은 값으로 설정하고, Opentelemetry Debug Exporter를 통해서 Metric을 확인해본다.](https://github.com/jayground8/example-opentelemetry-monitoring/tree/main/attribute_example)

### Nodejs

Nodejs Application에서 `Counter` 타입의 metric을 추가하고, 아래처럼 attribute value를 빈문자열로 정의한다.

```js
counter1.add(1, { hello: '' })
```

그러면 debug exporter를 통해서 아래와 같이 `Str()`으로 남는 것을 확인할 수 있다.

```bash
ScopeMetrics #1
ScopeMetrics SchemaURL:
InstrumentationScope default
Metric #0
Descriptor:
     -> Name: empty
     -> Description:
     -> Unit:
     -> DataType: Sum
     -> IsMonotonic: true
     -> AggregationTemporality: Cumulative
NumberDataPoints #0
Data point attributes:
     -> hello: Str()
StartTimestamp: 2024-10-26 00:05:49.732 +0000 UTC
Timestamp: 2024-10-26 00:06:46.47 +0000 UTC
Value: 1.000000
```

그리고 `Counter` 타입의 metric을 하나 더 추가하고, 아래처럼 attribute value를 `null`로 정의한다.

```js
counter2.add(1, { hello: null })
```

그러면 이번에는 debug exporter로 아래와 같이 `Empty()`로 남는 것을 확인할 수 있다.

```bash
Metric #1
Descriptor:
     -> Name: null
     -> Description:
     -> Unit:
     -> DataType: Sum
     -> IsMonotonic: true
     -> AggregationTemporality: Cumulative
NumberDataPoints #0
Data point attributes:
     -> hello: Empty()
StartTimestamp: 2024-10-26 00:05:49.732 +0000 UTC
Timestamp: 2024-10-26 00:06:46.47 +0000 UTC
Value: 1.000000
```

### Python

Python Application은 아래와 같이 `빈문자열`을 넣었을 때는

```python
counter1.add(1, {"test": ""})
```

아래처럼 `Str()`이 찍히는 것을 확인할 수 있다.

```bash
ScopeMetrics #1
ScopeMetrics SchemaURL:
InstrumentationScope test
Metric #0
Descriptor:
     -> Name: empty
     -> Description:
     -> Unit:
     -> DataType: Sum
     -> IsMonotonic: true
     -> AggregationTemporality: Cumulative
NumberDataPoints #0
Data point attributes:
     -> test: Str()
StartTimestamp: 2024-10-26 00:08:02.064389211 +0000 UTC
Timestamp: 2024-10-26 00:08:25.521302833 +0000 UTC
```

하지만 Nodejs와 다르게 아래와 같이 `None`을 설정하였을 때는

```python
counter2.add(1, {"test": None})
```

Python Opentelemetry 패키지에서 아래와 같이 에러가 발생한다.

```bash
Failed to encode key test: Invalid type <class 'NoneType'> of value None
Traceback (most recent call last):
  File "/venv/lib/python3.11/site-packages/opentelemetry/exporter/otlp/proto/common/_internal/__init__.py", line 113, in _encode_attributes
    pb2_attributes.append(_encode_key_value(key, value))
                          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/venv/lib/python3.11/site-packages/opentelemetry/exporter/otlp/proto/common/_internal/__init__.py", line 94, in _encode_key_value
    return PB2KeyValue(key=key, value=_encode_value(value))
                                      ^^^^^^^^^^^^^^^^^^^^
  File "/venv/lib/python3.11/site-packages/opentelemetry/exporter/otlp/proto/common/_internal/__init__.py", line 90, in _encode_value
    raise Exception(f"Invalid type {type(value)} of value {value}")
Exception: Invalid type <class 'NoneType'> of value None
```

그리고 최종적으로 Opentelemetry Collector에는 Attribute가 없는 상태로 Metric이 전달된다.

```bash
Metric #1
Descriptor:
     -> Name: none
     -> Description:
     -> Unit:
     -> DataType: Sum
     -> IsMonotonic: true
     -> AggregationTemporality: Cumulative
NumberDataPoints #0
StartTimestamp: 2024-10-26 00:08:02.064398086 +0000 UTC
Timestamp: 2024-10-26 00:08:25.521302833 +0000 UTC
Value: 1
```

## Thanos Receiver Error

위에서 살펴본 것처럼 Attribute Value과 `Str()`나 `Empty()` 설정되어서 Metric이 전달될 수 있다. 실제로 운영하면서 Nodejs에서는 [instrumentation-http](https://www.npmjs.com/package/@opentelemetry/instrumentation-http)에서 `net.host.port` Attribute value를 `Empty()`로 보내는 경우가 발생하였다. instrumentation-http가 Socket object를 통해서 host port를 가져오고, 그 값을 metric의 `net.host.port` attribute 값으로 설정하게 된다. 그런데 어떤 이유에서 이 값이 `undefined`이 되면서 최종적으로 `Empty()`로 설정되는 것으로 파악된다. 그리고 .Net instrumentation 중에서도 `Str()`를 설정하는 경우가 있었다.

문제는 Thanos Receiver를 통해서 Metric을 저장하려고 할 때, Thanos Receiver가 이러한 empty attribute value가 있을 때 아래처럼 에러를 발생한다.

```bash
2024-10-26T00:08:25.744Z	error	internal/queue_sender.go:92	Exporting failed. Dropping data.	{"kind": "exporter", "data_type": "metrics", "name": "prometheusremotewrite", "error": "Permanent error: Permanent error: Permanent error: remote write returned HTTP status 409 Conflict; err = %!w(<nil>): add 1 series: label set contains a label with empty name or value\n", "dropped_items": 5}
go.opentelemetry.io/collector/exporter/exporterhelper/internal.NewQueueSender.func1
	go.opentelemetry.io/collector/exporter@v0.111.0/exporterhelper/internal/queue_sender.go:92
go.opentelemetry.io/collector/exporter/internal/queue.(*boundedMemoryQueue[...]).Consume
	go.opentelemetry.io/collector/exporter@v0.111.0/internal/queue/bounded_memory_queue.go:52
go.opentelemetry.io/collector/exporter/internal/queue.(*Consumers[...]).Start.func1
	go.opentelemetry.io/collector/exporter@v0.111.0/internal/queue/consumers.go:43
```

테스트를 할 시점의 Thanos Version은 0.36.1이였고, [Thanos Receiver Code](https://github.com/thanos-io/thanos/blob/v0.36.1/pkg/receive/writer.go)를 보면 아래와 같다.

```go
if numLabelsEmpty > 0 {
    level.Info(tLogger).Log("msg", "Error on series with empty label name or value", "numDropped", numLabelsEmpty)
    errs.Add(errors.Wrapf(labelpb.ErrEmptyLabels, "add %d series", numLabelsEmpty))
}
```

`numLabelsEmpty`는 [label.go](https://github.com/thanos-io/thanos/blob/v0.36.1/pkg/store/labelpb/label.go)에서 아래와 같이 ValidateLabels 함수로 결정된다.

```go
func ValidateLabels(lbls []ZLabel) error {
	if len(lbls) == 0 {
		return ErrEmptyLabels
	}

	// Check first label.
	l0 := lbls[0]
	if l0.Name == "" || l0.Value == "" {
		return ErrEmptyLabels
	}

	// Iterate over the rest, check each for empty / duplicates and
	// check lexicographical (alphabetically) ordering.
	for _, l := range lbls[1:] {
		if l.Name == "" || l.Value == "" {
			return ErrEmptyLabels
		}

		if l.Name == l0.Name {
			return ErrDuplicateLabels
		}

		if l.Name < l0.Name {
			return ErrOutOfOrderLabels
		}
		l0 = l
	}

	return nil
}
```

## Str()로 보내는 것이 문제인가?

[Otel 1.38.0 규격 문서](https://opentelemetry.io/docs/specs/otel/common/)를 보면 아래와 같이 attribute key는 분명하게 null이나 empty string으로 설정되면 안되다고 설명되어 있다.

> The attribute key MUST be a non-null and non-empty string.

그리고 attribute value에 대해서는 empty string도 의미가 있는 것으로 판단하고 저장되어야 하는 것으로 설명되어 있다.

> Attribute values expressing a numerical value of zero, an empty string, or an empty array are considered meaningful and MUST be stored and passed on to processors / exporters.

Nodejs처럼 null, undefiend로 Empty()로 설정되는 것은 아래의 설명으로 규격에 맞지 않는 결과이고, Python처럼 None을 에러처리하고 아예 Attribute를 설정하지 않는 것이 더 바람직한 것으로 보인다.

> Attribute values of null are not valid and attempting to set a null value is undefined behavior.

## Thanos를 수정

Otel 1.38.0 규격 문서를 바탕으로 Attribute value가 Str()으로 설정되더라도 Thanos Receiver가 정상적으로 Metric을 수집할 수 있어야 된다고 판단하였다. Nodejs의 http instrumentation에서 Empty()로 남기는 것은 해당 라이브러리에서 개선되어야 하는 것으로 판단된다.

그래서 Thanos의 소스 코드에서 ValidateLabels 함수를 아래와 같이 수정하였다. 간단하게 Value에 대해서 "" 빈문자열을 ErrEmptyLabels로 판단하지 않도록 하였다.

```go
func ValidateLabels(lbls []ZLabel) error {
	if len(lbls) == 0 {
		return ErrEmptyLabels
	}

	// Check first label.
	l0 := lbls[0]
	if l0.Name == "" {
		return ErrEmptyLabels
	}

	// Iterate over the rest, check each for empty / duplicates and
	// check lexicographical (alphabetically) ordering.
	for _, l := range lbls[1:] {
		if l.Name == "" {
			return ErrEmptyLabels
		}

		if l.Name == l0.Name {
			return ErrDuplicateLabels
		}

		if l.Name < l0.Name {
			return ErrOutOfOrderLabels
		}
		l0 = l
	}

	return nil
}
```

[Thanos 소스코드에서 multi-stage Dockerfile를 제공](https://github.com/thanos-io/thanos/blob/v0.36.1/Dockerfile.multi-stage)하기 때문에 이 Dockerfile를 사용하여 수정된 소스코드를 바탕으로 Container Image를 빌드하였다.

```bash
docker build -t thanos:v0.36.1 -f Dockerfile.multi-stage .
```

Minikube에서 확인하기 위해서 Minikube에 로컬환경에서 빌드한 이미지를 추가하고,

```bash
minikube image load thanos:v0.36.1
```

Thanos Helm chart value에 image 설정을 추가한다.

```yaml
objstoreConfig: |-
  type: s3
  config:
    bucket: thanos
    endpoint: {{ include "thanos.minio.fullname" . }}.{{ .Release.Namespace }}.svc.cluster.local:9000
    access_key: minio
    secret_key: minio123
    insecure: true
image:
  repository: thanos
  tag: v0.36.1
  pullPolicy: Never
query:
  dnsDiscovery:
    sidecarsService: prometheus-kube-prometheus-thanos-discovery
    sidecarsNamespace: monitoring
compactor:
  enabled: true
storegateway:
  enabled: true
receive:
  enabled: true
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
minio:
  enabled: true
  auth:
    rootPassword: minio123
    rootUser: minio
  monitoringBuckets: thanos
  accessKey:
    password: minio
  secretKey:
    password: minio123
```

최종적으로 해당 value를 Minikube에 설치되어 있는 Thanos에 반영한다.

```bash
helm upgrade thanos \
    --values helm/thanos/values.yml \
    --namespace monitoring \
    bitnami/thanos
```

Attribute value가 Str(), Empty()로 설정되더라도 아래처럼 수집이 잘되는 것을 확인할 수 있다.

### Empty Attribute value 일 때

<img src="/static/images/thanos_empty-attribute_value.png" alt="empty attribute value on Grafana" />

### Non-Empty Attribute value 일 때

<img src="/static/images/thanos_non_empty-attribute_value.png" alt="non-empty attribute value on Grafana" />

## 결론

Thanos Receiver를 통해서 Metric를 저장할 때, Metric Attribute value가 `빈문자열`일 때 에러가 발생하였다. Otel 1.38.0 규격 문서를 확인했을 때 attribute key는 non-empty, non-null string값으로 설정되어야 된다고 정의되어 있었다. 하지만 attribute value의 경우에는 Empty String도 의미를 가질 수 있고, 이것도 저장되어야 한다고 정의되어 있었다. 따라서 Thanos의 소스코드를 수정하여 attribute value가 Empty String일 때도 저장할 수 있도록 하였다.
