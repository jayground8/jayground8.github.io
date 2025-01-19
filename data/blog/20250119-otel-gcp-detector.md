---
title: 'OpenTelemetry GcpDetector를 이해하기'
date: '2025-01-19'
tags: ['gcp', 'kubernetes', 'opentelemetry']
images: ['/static/images/social-banner.png']
summary: 'OpenTelemetry Operator로 Auto-Instrumentation을 주입할 수 있다. 그런데 환경변수 설정을 올바르게 하지 않거나 OpenTelemetry Collector에서 proccessor 설정을 제대로 해주지 않으면, Resource attribute중 k8s.namespace.name가 빈문자열로 보내질 수 있다. 이러한 경우에 Auto-Instrumentation에서 Resource attribute가 어떻게 자동으로 설정되는지 resourceDetector들을 이해하면 쉽게 해결할 수 있다. 따라서 이번 글에서는 Resource Detector들에 대해서 자세히 살펴본다.'
---

아래와 같은 환경에서 운영할 때, 어떻게 Resource attribute들이 설정되는지 세부적으로 이해하지 못하면 `k8s.namespace.name`이나 `container.name`이 빈 문자열로 나오는 것에 대한 해결책을 찾는데 시간을 낭비할 수 있다. 따라서 이번 글에서는 어떻게 구성되어 있는 자세한 설명을 하고자 한다.

## 가정된 환경

- GKE에서 OpenTelemetry로 Log, Metric, Trace를 수집
- [OpenTelemetry Operator로 Auto injection](https://opentelemetry.io/docs/kubernetes/operator/automatic/)을 설정
- Nodejs로 application을 개발

## Injecting Auto-Instrumentation

[OpenTelemetry 공식 문서에서 Nodejs에서 어플리케이션 코드를 수정하지 않고 --require flag를 통해서 OpenTelemetry Instrumentation 설정하는 것을 설명한다.](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/) OpenTelemetry Operator를 통해서 Auto-Instrumentation을 설정하면, Init Container를 통해서 필요한 npm module과 스크립트를 특정 위치에 mounting한다. 그리고 나의 Nodejs Application Container에 환경변수로 `NODE_OPTIONS`를 아래와 같이 설정한다.

```bash
--require /otel-auto-instrumentation-nodejs/autoinstrumentation.js
```

[`autoinstrumentation.js`는 아래와 같이 작성되어 있다.](https://github.com/open-telemetry/opentelemetry-operator/blob/main/autoinstrumentation/nodejs/src/autoinstrumentation.ts) Nodejs에서는 Trace와 Metric에 대해서 설정이 되기 때문에, Log는 Log API를 통해서 별도로 설정해야 한다.

```js
function getTraceExporter() {
  let protocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL
  switch (protocol) {
    case undefined:
    case '':
    case 'grpc':
      return new OTLPGrpcTraceExporter()
    case 'http/json':
      return new OTLPHttpTraceExporter()
    case 'http/protobuf':
      return new OTLPProtoTraceExporter()
    default:
      throw Error(
        `Creating traces exporter based on "${protocol}" protocol (configured via environment variable OTEL_EXPORTER_OTLP_PROTOCOL) is not implemented!`
      )
  }
}

function getMetricReader() {
  switch (process.env.OTEL_METRICS_EXPORTER) {
    case undefined:
    case '':
    case 'otlp':
      diag.info('using otel metrics exporter')
      return new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
      })
    case 'prometheus':
      diag.info('using prometheus metrics exporter')
      return new PrometheusExporter({})
    case 'none':
      diag.info('disabling metrics reader')
      return undefined
    default:
      throw Error(`no valid option for OTEL_METRICS_EXPORTER: ${process.env.OTEL_METRICS_EXPORTER}`)
  }
}

const sdk = new NodeSDK({
  autoDetectResources: true,
  instrumentations: [getNodeAutoInstrumentations()],
  traceExporter: getTraceExporter(),
  metricReader: getMetricReader(),
  resourceDetectors: [
    // Standard resource detectors.
    containerDetector,
    envDetector,
    hostDetector,
    osDetector,
    processDetector,

    // Cloud resource detectors.
    alibabaCloudEcsDetector,
    // Ordered AWS Resource Detectors as per:
    // https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/resourcedetectionprocessor/README.md#ordering
    awsEksDetector,
    awsEc2Detector,
    gcpDetector,
  ],
})

sdk.start()
```

## resourceDetector

위에서 OpenTelemetry Operator가 Auto-Instrumentation을 주입하는 방법을 간략하게 살펴보았다. `NODE_OPTIONS` 환경변수말고도 OpenTelemetry Operator에 의해서 설정되는 환경변수들이 존재한다. 그중에 `OTEL_RESOURCE_ATTRIBUTES`는 아래와 같이 설정이 되어 있다. (보기 편하도록 줄바꿈을 추가했다. 실제로는 줄바꿈없이 한줄의 문자열로 되어 있다.)

```bash
k8s.container.name=app,
k8s.deployment.name=example,
k8s.namespace.name=tutorial,
k8s.node.name=$(OTEL_RESOURCE_ATTRIBUTES_NODE_NAME),
k8s.pod.name=$(OTEL_RESOURCE_ATTRIBUTES_POD_NAME),
k8s.replicaset.name=tutorial-54bb8755cf,
service.instance.id=dtutorial.$(OTEL_RESOURCE_ATTRIBUTES_POD_NAME).app,
service.version=3faacb70440664dc3dea73d21aab98ffe90e3e24
```

위의 `autoinstrumentation.js` 코드에서 resourceDetectors부분이 아래와 같이 설정되어 있었다. 자동으로 OpenTelemetry Resource attribute들을 설정해주는 Detector들이 정의되어 있다.

```js
resourceDetectors:
[
    // Standard resource detectors.
    containerDetector,
    envDetector,
    hostDetector,
    osDetector,
    processDetector,

    // Cloud resource detectors.
    alibabaCloudEcsDetector,
    // Ordered AWS Resource Detectors as per:
    // https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/resourcedetectionprocessor/README.md#ordering
    awsEksDetector,
    awsEc2Detector,
    gcpDetector,
],
```

### envDetector

resourceDetectors Array를 보면 envDetector가 보인다. [소스코드를 보면 아래와 같이 OTEL_RESOURCE_ATTRIBUTES 환경변수의 값을 사용하여 Resourc의 attribute를 설정하는 것을 확인할 수 있다.](https://github.com/open-telemetry/opentelemetry-js/blob/main/packages/opentelemetry-resources/src/detectors/EnvDetectorSync.ts) OpenTelemetry Operator가 OTEL_RESOURCE_ATTRIBUTES를 자동으로 설정하고, envDetector에 의해서 자동으로 Resource attribute들이 설정되는 것이다.

```js
detect(_config?: ResourceDetectionConfig): IResource {
  const attributes: Attributes = {};
  const env = getEnv();

  const rawAttributes = env.OTEL_RESOURCE_ATTRIBUTES;
  const serviceName = env.OTEL_SERVICE_NAME;

  if (rawAttributes) {
    try {
      const parsedAttributes = this._parseResourceAttributes(rawAttributes);
      Object.assign(attributes, parsedAttributes);
    } catch (e) {
      diag.debug(`EnvDetector failed: ${e.message}`);
    }
  }

  if (serviceName) {
    attributes[SEMRESATTRS_SERVICE_NAME] = serviceName;
  }

  return new Resource(attributes);
}
```

`OTEL_LOG_LEVEL` 환경변수를 `DEBUG`로 설정하면 아래와 같이 envDetector로 설정된 것을 확인할 수 있다.

```js
EnvDetector found resource. Resource {
  _attributes: {
    'k8s.container.name': 'app',
    'k8s.deployment.name': 'example',
    'k8s.namespace.name': 'tutorial',
    'k8s.node.name': 'gke-tutorial-k8s-cluster-default-pool-d4535262-s702',
    'k8s.pod.name': 'example-54bb8755cf-7fgkp',
    'k8s.replicaset.name': 'example-54bb8755cf',
    'service.instance.id': 'tutorial.example-54bb8755cf-7fgkp.app',
    'service.version': '3faacb70440664dc3dea73d21aab98ffe90e3e24',
    'service.name': 'example-svc'
  },
  asyncAttributesPending: false,
  _syncAttributes: {},
  _asyncAttributesPromise: Promise {
    {
      'k8s.container.name': 'app',
      'k8s.deployment.name': 'example',
      'k8s.namespace.name': 'tutorial',
      'k8s.node.name': 'gke-tutorial-k8s-cluster-default-pool-d4535262-s702',
      'k8s.pod.name': 'example-54bb8755cf-7fgkp',
      'k8s.replicaset.name': 'example-54bb8755cf',
      'service.instance.id': 'tutorial.example-54bb8755cf-7fgkp.app',
      'service.version': '3faacb70440664dc3dea73d21aab98ffe90e3e24',
      'service.name': 'example-svc'
    },
    [Symbol(async_id_symbol)]: 111,
    [Symbol(trigger_async_id_symbol)]: 0
  }
}
```

### gcpDetector

resourceDetectors Array의 마지막 index에 `gcpDetector`가 있다. GKE를 사용하는 경우에는 해당 detector의 로직이 실행된다. [`gcpDetector`의 소스코드를 살펴보면 아래와 같이 k8s.namespace.name과 k8s.container.name을 특정 환경변수로 설정되는 것을 확인할 수 있다.](https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/detectors/node/opentelemetry-resource-detector-gcp/src/detectors/GcpDetector.ts) envDetector를 통해서 설정되었던 k8s.namespace.name과 container.name이 마지막의 gcpDetector에 의해서 덮어쓰기가 되는 것이다. Container에 NAMESPACE, CONTAINER_NAME 환경변수가 설정되지 않았다면 이제 이부분이 빈 문자열로 덮어쓰여진다.

```js
private _addK8sAttributes(
  attributes: ResourceAttributes,
  clusterName: string
): void {
  const env = getEnv();

  attributes[SEMRESATTRS_K8S_CLUSTER_NAME] = clusterName;
  attributes[SEMRESATTRS_K8S_NAMESPACE_NAME] = env.NAMESPACE;
  attributes[SEMRESATTRS_K8S_POD_NAME] = env.HOSTNAME;
  attributes[SEMRESATTRS_CONTAINER_NAME] = env.CONTAINER_NAME;
}
```

`OTEL_LOG_LEVEL` 환경변수를 `DEBUG`로 설정하면 아래와 같이 설정된 것을 확인할 수 있다.

```js
GcpDetector found resource. Resource {
  _attributes: {
    'cloud.account.id': 'tutorial-prj',
    'host.id': '6769112033492981631',
    'host.name': 'gke-tutorial-k8s-cluster-default-pool-d4535262-s702.c.tutorial-prj.internal',
    'cloud.availability_zone': 'us-west1-a',
    'cloud.provider': 'gcp',
    'k8s.cluster.name': 'tutorial-k8s-cluster',
    'k8s.namespace.name': '',
    'k8s.pod.name': 'example-54bb8755cf-7fgkp',
    'container.name': ''
  },
  asyncAttributesPending: false,
  _syncAttributes: {},
  _asyncAttributesPromise: Promise {
    {
      'cloud.account.id': 'tutorial-prj',
      'host.id': '6769112033492981631',
      'host.name': 'gke-tutorial-k8s-cluster-default-pool-d4535262-s702.c.tutorial-prj.internal',
      'cloud.availability_zone': 'us-west1-a',
      'cloud.provider': 'gcp',
      'k8s.cluster.name': 'tutorial-k8s-cluster',
      'k8s.namespace.name': '',
      'k8s.pod.name': 'example-54bb8755cf-7fgkp',
      'container.name': ''
    },
    [Symbol(async_id_symbol)]: 44635,
    [Symbol(trigger_async_id_symbol)]: 0
  }
}
```

## pod

이제 auto-instrumentation을 사용할 때, 다양한 종류의 resource detector를 통해서 resource attribute가 자동으로 설정되는 것을 이해했다. 그리고 resource detector의 순서에 따라서 GKE를 사용할 때는 gcpDetector에서 필요한 환경변수를 설정해야 되는 것을 알았다. 따라서 Pod에 아래와 같이 필요한 환경변수를 추가해준다. 이제 위에서 gcpDetector에서 빈문자열 값이 원하던 값으로 설정된 것으로 확인할 수 있다.

```yaml
env:
  - name: NAMESPACE
    valueFrom:
      fieldRef:
        fieldPath: metadata.namespace
  - name: CONTAINER_NAME
    value: app
```

## OpenTelelemetry Collector

실제로 OpenTelemetry를 사용할 때, OpenTelemetry Collector를 활용하는 것을 추천한다. OpenTelemetry에서 여러가지 처리를 해주는 processor에서 [Kubernetes Attribute Processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/k8sattributesprocessor/README.md)를 활횽하면 OpenTelemetry Colllector에서 필요한 Resource Attribute들을 설정할 수가 있다. k8s.namespace.name은 default로 설정되어 있다.

- k8s.namespace.name
- k8s.pod.name
- k8s.pod.uid
- k8s.pod.start_time
- k8s.deployment.name
- k8s.node.name

그리고 container.id resource attribute가 제공되면 k8s Attribute Processor에서 아래와 같은 attribute들도 추가할 수 있다.

- k8s.container.name
- container.image.name
- container.image.tag
- container.image.repo_digests

위에서 containerDetector가 Array의 첫번째 값으로 설정되어 있는 것을 확인해보자. [containerDetector는 container.id을 자동으로 채워주는 역할을 한다.](https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/detectors/node/opentelemetry-resource-detector-container/src/detectors/ContainerDetector.ts) Kubernetes에서는 [Downward API를 통해서 pod 이름, pod의 namespace 등을 참조할 수 있다.](https://kubernetes.io/docs/concepts/workloads/pods/downward-api/) 하지만 container.id는 Kubernetes에서 제공하는 방법이 없다. 따라서 containerDectector에서는 아래와 같이 Cgroup이 V1일 때와 V2일 때 proc file system에 있는 정보를 통해서 container id를 가져오려고 한다.

```ts
readonly DEFAULT_CGROUP_V1_PATH = '/proc/self/cgroup';
readonly DEFAULT_CGROUP_V2_PATH = '/proc/self/mountinfo';
```

GKE에서는 현재 버전에서는 cgroup V2으로 기본 운영된다. V1은 deprecated될 예정이다. 따라서 containerDetector에서 /proc/self/mountinfo를 통해서 contaienr id를 가져올려고 하지만, 해당 파일에 contaienr id 정보가 없다. 따라서 containerDetector로 container.id를 정상적으로 설정하지 못 한다.

> For versions 1.26 or later, cgroupv2 is the default for new nodes.

결론적으로 OpenTelemetry Operator로 Auto-Insturmentation을 주입할 때, k8s.container.name은 자동으로 채워진다. 그리고 NAMESPACE 환경변수를 통해서 GcpDetector가 k8s.namespace.name을 설정하도록 하지 않아도, k8s Attribute Processor를 통해서 해당 attribute를 채워 넣을 수 있다.

## 결론

OpenTelemetry에서 Resource Attribute를 통해서 Log, Trace, Metric 데이터에 원하는 메타데이터를 추가할 수 있다. OpenTelemetry에서는 소스코드 변경없이 Instrumentation을 Java의 경우는 java agent를 통해서, nodejs는 --require flag를 통해서, 그리고 python은 sitecustomize를 이용해서 구현하고 있다. OpenTelemetry Operator를 사용하면 Auto-Instrumentation을 Kubernetes 환경에서 annotation으로 편하게 주입할 수 있다. ([참고로 Python FastAPI를 Uvicorn으로 사용할 때는 정상적으로 작동하지 않았다](https://github.com/open-telemetry/opentelemetry-python-contrib/issues/385)) Auto-Instrumentation 과정에서 Resource Attribute들도 Resource Detector에 의해서 자동으로 설정이 된다. 이번 글에서는 envDetector, gcpDetector, containerDetector이 어떻게 Resource Attribute들을 자동으로 설정해주는지 살펴보았다. 혹시 GKE를 사용하는 과정에서 k8s.namespace.name이 빈문자열로 설정이 되면, resource detector들에 대한 이해를 바탕으로 올바른 설정을 해줄 수 있을 것이다.
