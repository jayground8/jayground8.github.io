---
title: 'Calico kube-controller 이해하기'
date: '2023-07-22'
tags: ['kubernetes', 'calico']
summary: 'Calico에서 어떻게 CRD를 활용하는지 이해하기 위해서 Calico Opensource 버전의 깃헙 소스코드를 살펴보게 되었다. Calico archiecture에서 kube-controller 부분이 어떤 역할을 하는지 소스 코드를 통해서 이해할 수 있게 되었다. kube-controller들은 kubernetes native resource에 대한 변경을 calico data source와 sync해주는 역할을 하고 있었다. 그런데 projectcalico.org custom resource들을 생성/변경할 때는 calico system에서 어떻게 detect를 하고 business logic을 수행하는지는 이해할 수가 없었다.'
---

이전에 `kubebuilder`를 통해서 `Programming Kubernetes`에서 설명한 [At resource를 watch하는 Custom controller를 직접 작성](https://jayground8.github.io/blog/20230715-k8s-controller)했다. 그다음에는 ifkakao(2022) `Testing Kubernetes Controller` 발표에서 사용된 [example인 BlueGreen resource에 대한 Custom controller를 kubebuilder로 작성](https://jayground8.github.io/blog/20230716-if-kakao-2022-k8s-controller)했다. 이번에는 Calico에서 어떻게 CRD와 Custom contoller를 활용하고 있는지 [Source code](https://github.com/projectcalico/calico)를 확인해봤다. (이 글을 작성하는 시점에는 Calico OpenSource Version 3.26을 확인하였다.)

## Calico kube-controllers

source code를 보면 `kube-controllers` 디렉터리 안에 아래처럼 controller 코드가 있는 것을 확인할 수 있다.

```bash
.
├── controller
│   └── controller.go
├── flannelmigration
│   ├── config.go
│   ├── config_test.go
│   ├── flannel_migration_fv_test.go
│   ├── flannelmigration_suite_test.go
│   ├── ipam_migrator.go
│   ├── k8s_resources.go
│   ├── migration_controller.go
│   └── network_migrator.go
├── namespace
│   ├── namespace_controller.go
│   ├── namespace_controller_fv_test.go
│   └── namespace_suite_test.go
├── networkpolicy
│   ├── policy_controller.go
│   ├── policy_controller_fv_test.go
│   └── policy_suite_test.go
├── node
│   ├── auto_hep_fv_test.go
│   ├── controller.go
│   ├── errors.go
│   ├── etcd_ipam_gc_fv_test.go
│   ├── fake_client.go
│   ├── hostendpoints.go
│   ├── ipam.go
│   ├── ipam_allocation.go
│   ├── ipam_test.go
│   ├── kdd_ipam_gc_fv_test.go
│   ├── labels.go
│   ├── metrics_fv_test.go
│   ├── node_controller_fv_test.go
│   ├── node_deleter.go
│   ├── node_suite_test.go
│   ├── pool_manager.go
│   └── syncer.go
├── pod
│   ├── pod_controller.go
│   ├── pod_controller_fv_test.go
│   └── pod_suite_test.go
└── serviceaccount
    ├── serviceaccount_controller.go
    ├── serviceaccount_controller_fv_test.go
    └── serviceaccount_suite_test.go
```

`Makefile`를 확인해보면 아래와 같이 build환경을 갖춘 Container Image를 통해서 compile을 하게 된다. (기타 arguments 생략)

```bash
go build -o bin/kube-controllers-linux-amd64 ./cmd/kube-controllers/
```

build하는 `/cmd/kube-controllers`의 `main.go`를 확인해보면, `controllerControl`이라는 struct type에 Controller instance들을 저장하게 된다.

```go
controllerCtrl := &controllerControl{
		ctx:         ctx,
		controllers: make(map[string]controller.Controller),
		stop:        stop,
		informers:   make([]cache.SharedIndexInformer, 0),
	}
```

`InitControllers` method를 확인하면 설정값에 따라서 `Pod`, `Namespace`, `NetworkPolicy`, `Node`, `ServiceAccount`에 관련된 controller를 설정하게 된다.

```go
controllerCtrl.InitControllers(ctx, runCfg, k8sClientset, calicoClient)
```

```go
if cfg.Controllers.WorkloadEndpoint != nil {
  podController := pod.NewPodController(...생략)
  cc.controllers["Pod"] = podController
  cc.registerInformers(podInformer)
}

if cfg.Controllers.Namespace != nil {
  namespaceController := namespace.NewNamespaceController(...생략)
  cc.controllers["Namespace"] = namespaceController
}

...생략
```

[kube-controller에 대한 설정값을 문서](https://docs.tigera.io/calico/latest/reference/kube-controllers/configuration#the-calicokube-controllers-container)를 확인해보면 calico datasource로 Kubernetes의 etcd를 공유해서 사용하고 싶으면 환경 변수 `DATASTORE_TYPE` 값을 `kubernetes`로 설정해줘야 한다. 그리고 `node`에 관한 `kube-controller`를 enable하기 위해서 `ENABLED_CONTROLLERS`환경변수를 `node`로 설정해야 한다. 나머지 controller는 default로 enable되기 때문에 사용하지 않고 싶을 때만 명시적으로 환경변수로 disable 시켜줘야 한다.

나는 Minikube에서 Addon으로 Calico를 추가해서 Kubernetes cluster를 사용하고 있다. 그래서 `calico-kube-controllers`의 환경변수 설정값을 확인하니 아래처럼 설정된 것을 확인 할 수 있었다.

```bash
kubectl describe deployments calico-kube-controllers -n kube-system
```

```bash
Environment:
  ENABLED_CONTROLLERS:  node
  DATASTORE_TYPE:       kubernetes
```

그다음에 `main.go`에서 최종적으로 `RunController` method를 호출하고, goroutine으로 `controllerControl` struct에 추가했던 `informer`와 `controller`들의 Run method를 호출해준다.

```go
func (cc *controllerControl) RunControllers() {
	for _, inf := range cc.informers {
		log.WithField("informer", inf).Info("Starting informer")
		go inf.Run(cc.stop)
	}

	for controllerType, c := range cc.controllers {
		log.WithField("ControllerType", controllerType).Info("Starting controller")
		go c.Run(cc.stop)
	}

	select {
	case <-cc.ctx.Done():
		log.Warn("context cancelled")
	case <-cc.restart:
		log.Warn("configuration changed; restarting")
	}
	close(cc.stop)
}
```

`c.Run(cc.stop)`은 아래처럼 work process를 groutine으로 실행하게 되고, workqueue에 item이 추가될때까지 기다리게 되는 무한 loop으로 돌아간다.

```go
for i := 0; i < c.cfg.NumberOfWorkers; i++ {
		go c.runWorker()
	}

...생략

func (c *namespaceController) runWorker() {
	for c.processNextItem() {
	}
}

func (c *namespaceController) processNextItem() bool {
	workqueue := c.resourceCache.GetQueue()
  ... 생략
  workqueue.Done(key)
	return true
}
```

각각의 contoller가 하는 일은 [문서에서 아래처럼 친절하게 설명되어 있다](https://docs.tigera.io/calico/latest/reference/kube-controllers/configuration#the-calicokube-controllers-container).

- policy controller: watches Kubernetes network policies in the Kubernetes API, and syncs the policies to the datastore (etcd) as Calico network policies. Felix implements network policies in the dataplane.
- namespace controller: watches namespaces and programs Calico profiles.
- serviceaccount controller: watches service accounts and programs Calico profiles.
- workloadendpoint controller: watches for changes to pod labels and updates Calico workload endpoints.
- node controller: watches for the removal of Kubernetes nodes and removes corresponding data from Calico, and optionally watches for node updates to create and sync host endpoints for each node.

이제 controller의 코드를 확인해본다. 이전에는 kubebuilder로 bootstrap을 해서 작성을 했었다. calico에서는 kubebuilder를 쓰는 것이 아니기 때문에, [kubernetes code-generator](https://github.com/kubernetes/code-generator)를 활용하여 custom controller를 작성하는 방법을 참조하여 코드를 이해했다.

### pod controller

`workloadendpoint controller`는 Pod informer를 사용하고 있다. `informer factory`를 통해서 worker들이 공유해서 사용할 수 있는 `informer`를 생성한다.

```go
factory := informers.NewSharedInformerFactory(k8sClientset, 0)
podInformer := factory.Core().V1().Pods().Informer()
```

`controller`에서는 인자로 전달된 informer에 이제 `ADD`, `UPDATE`, `DELETE` event를 처리할 event handler를 추가하게 된다.

```go
if _, err := informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj interface{}) {
    },
    UpdateFunc: func(oldObj interface{}, newObj interface{}) {
    },
    DeleteFunc: func(obj interface{}) {
    }
}
```

Informer는 cache를 통해서 매번 API server에 요청할 필요가 없고, polling 대신에 watch로 resource에 대한 변화 Event에 작동될 수 있는 Interface를 제공한다. Controller에서는 정의된 Informer에 event에 따라 실행할 로직을 event handler를 등록하여 추가하게 된다. 이렇게 `podInformer`로 Pod object가 변화될 때마다 calico data source와 sync를 맞춰준다.

calico custom resource에 대한 Interface제공하는 clientsets은 아래처럼 WorkloadEndpoints를 처음 가져와서 cache에 담는데 사용한다.

```go
workloadEndpoints, err := c.WorkloadEndpoints().List(ctx, options.ListOptions{})
```

### networkpolicy controller

Pod resource에 대한 informer는 `NewSharedInformerFactory`을 통해서 이제 여러 worker이 공유해서 사용할 수 있도록 했는데, networkpolicy controller에서는 아래처럼 informer를 생성하고 있다. 이렇게 한 이유는 pod informer의 경우에는 node controller와 pod controller가 둘다 사용하고 있기 때문이고, networkpolicy resource에 대해서는 여러 worker가 사용하지 않으니깐 이렇게 생성한 것일까? 그렇다면 node informer는 node controller에서 밖에 사용하지 않는데, 왜 `NewSharedInformerFactory`를 사용했을까?

```go
listWatcher := cache.NewListWatchFromClient(
  clientset.NetworkingV1().RESTClient(),
  "networkpolicies", "",
  fields.Everything()
)

_, informer := cache.NewIndexerInformer(listWatcher, &networkingv1.NetworkPolicy{}, 0, cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj interface{}) {
    },
    UpdateFunc: func(oldObj interface{}, newObj interface{}) {
    },
    DeleteFunc: func(obj interface{}) {
    }
  }, cache.Indexers{})
```

`pod Controller`와 동일하게 Kubernetes NetworkPolicy resource가 `ADD`, `UPDATE`, `DELETE`되었을 때, calico datastore를 업데이트 해주는 역할을 한다. 그리고 아래처럼 calico clientsets으로 `projectcalico.org` Group `v3` Version `NetworkPolicy` Kind를 가져오고 있다.

```go
calicoPolicies, err := c.NetworkPolicies().List(ctx, options.ListOptions{})
```

### Calico CRD와 연결점은 어떻게 되는거지?

[code-generator를 사용하는 At custom controller의 소스 코드](https://github.com/programming-kubernetes/cnat/blob/master/cnat-client-go/main.go)를 보면 아래처럼 custom resource에 대해서 code-generator로 생성된 informer를 사용하고 있다. At resource가 변경될 때, Event에 따라서 로직을 수행하게 된다.

```go
informers "github.com/programming-kubernetes/cnat/cnat-client-go/pkg/generated/informers/externalversions"

...생략
cnatInformerFactory := informers.NewSharedInformerFactory(cnatClient, time.Minute*10)
```

`Calico`를 Addon으로 추가한 Minikube에서 `kubectl get crds`를 실행하면 아래처럼 `crd`가 있는 것을 확인할 수 있다. `pod controller`, `network policy contoller`, `service account controller`를 보면, kubernetest의 native resource가 변화할 때 informer를 통해서 calico data source를 sync하고 있다. 그런데 아래의 CRD의 custom resource가 변경되는 거에 대해서 로직을 수행하는 코드는 controller에 없다. 그럼 그부분은 어디서 담당하고 있는 것일까?

```bash
NAME                                                  CREATED AT
bgpconfigurations.crd.projectcalico.org               2023-07-03T07:55:54Z
bgppeers.crd.projectcalico.org                        2023-07-03T07:55:54Z
blockaffinities.crd.projectcalico.org                 2023-07-03T07:55:54Z
caliconodestatuses.crd.projectcalico.org              2023-07-03T07:55:54Z
clusterinformations.crd.projectcalico.org             2023-07-03T07:55:54Z
felixconfigurations.crd.projectcalico.org             2023-07-03T07:55:54Z
globalnetworkpolicies.crd.projectcalico.org           2023-07-03T07:55:55Z
globalnetworksets.crd.projectcalico.org               2023-07-03T07:55:55Z
hostendpoints.crd.projectcalico.org                   2023-07-03T07:55:55Z
ipamblocks.crd.projectcalico.org                      2023-07-03T07:55:55Z
ipamconfigs.crd.projectcalico.org                     2023-07-03T07:55:55Z
ipamhandles.crd.projectcalico.org                     2023-07-03T07:55:55Z
ippools.crd.projectcalico.org                         2023-07-03T07:55:55Z
ipreservations.crd.projectcalico.org                  2023-07-03T07:55:55Z
kubecontrollersconfigurations.crd.projectcalico.org   2023-07-03T07:55:55Z
networkpolicies.crd.projectcalico.org                 2023-07-03T07:55:55Z
networksets.crd.projectcalico.org
```

calicoctl을 통해서 custom resource를 생성해본다. (calicoctl을 통해서 calico에서 필요한 validation과 defaulting을 수행한다. 그런데 calico apiserver를 설치하면 calicoctl없이 그냥 kubectl을 이용해서 할 수 있다.)

```bash
calicoctl create -f - <<EOF
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: allow-busybox-egress
  namespace: advanced-policy-demo
spec:
  selector: run == 'access'
  types:
  - Egress
  egress:
  - action: Allow
EOF
```

`kubectl api-resources`로 확인해보면 NetworkPolicy로 동일한 KIND인데 Group과 Version이 다른 것이 보인다.

```bash
NAME                              SHORTNAMES   APIVERSION                             NAMESPACED   KIND
networkpolicies                                crd.projectcalico.org/v1               true         NetworkPolicy
networkpolicies                   netpol       networking.k8s.io/v1                   true         NetworkPolicy
```

`kubectl get networkpolicy -A`를 하게 되면, networking.k8s.io/v1의 NetworkPolicy만 보여주기 때문에 아래처럼 Group과 Version을 명시해서 resource를 가져왔다.

```bash
kubectl get networkpolicy.v1.crd.projectcalico.org
```

이렇게 Custom Resource를 생성했으면 이것이 Calico의 data source와 sync가 되고, 그 데이터를 통해서 Felix가 iptables rule이나 eBPF로 해당 내용을 적용할 것이다. 그런데 Calico system에서 custom resource가 생성되고나 변경된 것을 탐지해서 그것에 따라서 로직을 수행하는 부분은 어디에서 찾을 수 있는거지? 🤔 이것에 대한 실마리가 안 찾아져서 Calico Community Slack channel에 들어가서 질문을 남겼다.
