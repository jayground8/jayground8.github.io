---
title: '오픈소스 Kubernetes External Secrets 살펴보기'
date: '2023-07-30'
tags: ['kubernetes']
summary: 'CRD와 Custom Controller를 사용하는 프로젝트에 대해서 더 알고 싶은 상황에서, External Secrets이라는 프로젝트를 발견하게 되었다. External Secrets는 Vault, AWS secret manager와 같이 secret 관리하는 Tool들과 Kubernetes secret을 CRD을 통해서 sync할 수 있게 해준다. 이 프로젝트는 kubebuilder를 사용하였는데, 소스코드를 보면서 어떻게 구현한 건지 자세히 살펴보았다.'
---

우연히 [Kubernetes External Secrets](https://github.com/external-secrets/external-secrets) 이름의 오픈소스 프로젝트를 알게 되었다. 이 프로젝트는 Valut, AWS Secret Manager 같은 tool을 single source of truth로 다수의 kubernetes cluster가 사용할 수 있도록 해준다. custom controller로 이러한 tool의 secret 정보를 Kubernetes secret과 Sync를 하게 된다. 이제 tool의 secret rotation 기능을 사용한다면 바뀐 secrets이 Kubernetes secrets에 적용되고, Deployment resource에 있는 secret 정보가 바뀌면서 다시 배포가 될 수 있겠다.

## Getting Started로 파악해보기

[External Secrests 문서의 Getting Started](https://external-secrets.io/v0.8.5/introduction/getting-started/)에서 AWS SecretManager를 활용하는 예제를 보여준다. 먼저 `SecretStore` resource를 생성하게 된다.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: secretstore-sample
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        secretRef:
          accessKeyIDSecretRef:
            name: awssm-secret
            key: access-key
          secretAccessKeySecretRef:
            name: awssm-secret
            key: secret-access-key
```

그리고 `ExternalSecret` 리소스를 만들게 되고, spec에서 `secretStoreRef`로 위에 만들어진 `SecretStore` 리소스 오브젝트를 가리키게 된다.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: example
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: secretstore-sample
    kind: SecretStore
  target:
    name: secret-to-be-created
    creationPolicy: Owner
  data:
    - secretKey: secret-key-to-be-managed
      remoteRef:
        key: provider-key
        version: provider-key-version
        property: provider-key-property
  dataFrom:
    - extract:
        key: remote-key-in-the-provider
```

`createPolicy: Owner`로 설정했는데, [External Secrets 문서](https://external-secrets.io/v0.8.5/guides/ownership-deletion-policy/)를 보면 아래와 같이 설명이 되어 있다. `Owner`로 설정을 하면 Kubernetes secret의 ownerReference를 설정하게 된다. 그리고 ExternalSecret custom resource가 삭제 될때 Kubernetes secret resource도 같이 삭제 된다.

> The External Secret Operator creates secret and sets the ownerReference field on the Secret. This secret is subject to garbage collection if the initial ExternalSecret is absent. If a secret with the same name already exists that is not owned by the controller it will result in a conflict. The operator will just error out, not claiming the ownership.

## 소스 코드로 이해하기

이제 소스코드를 확인해보자. 해당 프로젝트는 kubebuilder를 사용했고, `pkg/controllers`에서 `externalsecret_controller.go`를 찾을 수 있었다. 가장 먼저 봐야 할 것은 아래처럼 register package를 import하는 것이다.

`externalsecret_controller.go`

```go
import (
  _ "github.com/external-secrets/external-secrets/pkg/provider/register"
)
```

`register.go`를 확인해보면 아래처럼 다양한 provider들에 대해서 등록하는 package들이 import되고 있다.

`register.go`

```go
package register

import (
	_ "github.com/external-secrets/external-secrets/pkg/provider/akeyless"
	_ "github.com/external-secrets/external-secrets/pkg/provider/alibaba"
	_ "github.com/external-secrets/external-secrets/pkg/provider/aws"
	_ "github.com/external-secrets/external-secrets/pkg/provider/azure/keyvault"
	_ "github.com/external-secrets/external-secrets/pkg/provider/conjur"
	_ "github.com/external-secrets/external-secrets/pkg/provider/delinea"
	_ "github.com/external-secrets/external-secrets/pkg/provider/doppler"
	_ "github.com/external-secrets/external-secrets/pkg/provider/fake"
	_ "github.com/external-secrets/external-secrets/pkg/provider/gcp/secretmanager"
	_ "github.com/external-secrets/external-secrets/pkg/provider/gitlab"
	_ "github.com/external-secrets/external-secrets/pkg/provider/ibm"
	_ "github.com/external-secrets/external-secrets/pkg/provider/keepersecurity"
	_ "github.com/external-secrets/external-secrets/pkg/provider/kubernetes"
	_ "github.com/external-secrets/external-secrets/pkg/provider/onepassword"
	_ "github.com/external-secrets/external-secrets/pkg/provider/oracle"
	_ "github.com/external-secrets/external-secrets/pkg/provider/scaleway"
	_ "github.com/external-secrets/external-secrets/pkg/provider/senhasegura"
	_ "github.com/external-secrets/external-secrets/pkg/provider/vault"
	_ "github.com/external-secrets/external-secrets/pkg/provider/webhook"
	_ "github.com/external-secrets/external-secrets/pkg/provider/yandex/certificatemanager"
	_ "github.com/external-secrets/external-secrets/pkg/provider/yandex/lockbox"
)
```

예제에서 SecretManager를 사용하고 있기 때문에, `aws` provider package를 살펴보자. `aws.go`를 보면 아래처럼 init 함수로 Provider 객체를 등록하고 있다.

`pkg/provider/aws.go`

```go
func init() {
	esv1beta1.Register(&Provider{}, &esv1beta1.SecretStoreProvider{
		AWS: &esv1beta1.AWSProvider{},
	})
}
```

등록하는 로직은 아래처럼 map type에 Provider를 value로 설정하는 것이다. `builder`라는 map 데이터 구조에 provider를 저장하게 된다.

`provider_scheme.go`

```go
var builder map[string]Provider
var buildlock sync.RWMutex

func init() {
	builder = make(map[string]Provider)
}

func Register(s Provider, storeSpec *SecretStoreProvider) {
	storeName, err := getProviderName(storeSpec)
	if err != nil {
		panic(fmt.Sprintf("store error registering schema: %s", err.Error()))
	}

	buildlock.Lock()
	defer buildlock.Unlock()
	_, exists := builder[storeName]
	if exists {
		panic(fmt.Sprintf("store %q already registered", storeName))
	}

	builder[storeName] = s
}
```

이제 ExternalSecret Controller의 중요 로직들을 정리해보면 아래와 같다.

`externalsecret_controller.go`

```go
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
  // go-client로 Event로 전달된 ExternalSecret의 값을 가져온다.
  var externalSecret esv1beta1.ExternalSecret
	err := r.Get(ctx, req.NamespacedName, &externalSecret)

  // spec:
  //  refreshInterval: 1h
  refreshInt := r.RequeueInterval
	if externalSecret.Spec.RefreshInterval != nil {
		refreshInt = externalSecret.Spec.RefreshInterval.Duration
	}

  // spec:
  //  target:
  //    name: secret-to-be-created
  secretName := externalSecret.Spec.Target.Name
	if secretName == "" {
		secretName = externalSecret.ObjectMeta.Name
	}

  // ExternalSecret의 spec에서 가져온 name과 namespace로
  // Kubernetest Secret resource를 가져옴
  var existingSecret v1.Secret
	err = r.Get(ctx, types.NamespacedName{
		Name:      secretName,
		Namespace: externalSecret.Namespace,
	}, &existingSecret)
	if err != nil && !apierrors.IsNotFound(err) {
		log.Error(err, errGetExistingSecret)
	}

  // defer로 마지막에 ExternalSecret Status 정보를 마지막에 업데이트 한다.
  p := client.MergeFrom(externalSecret.DeepCopy())
	defer func() {
		err = r.Status().Patch(ctx, &externalSecret, p)
		if err != nil {
			log.Error(err, errPatchStatus)
		}
	}()

  // Secret Manger로부터 secret data를 가져온다.
  dataMap, err := r.getProviderSecretData(ctx, &externalSecret)

  // 예제에서는 deletionPolicy를 정의하지 않았지만
  // default는 Retain으로 Secret manager에 해당 데이터가 없더라도
  // Kubernetes secret은 그냥 유지한다.
  // Delete로 설정하면 Secret manager에는 없는데, Kubernetes secret은 존재하면
  // 이 resource를 삭제 할수 있다.
  if len(dataMap) == 0 {
		switch externalSecret.Spec.Target.DeletionPolicy {
		// delete secret and return early.
		case esv1beta1.DeletionPolicyDelete:
    case esv1beta1.DeletionPolicyMerge:
    case esv1beta1.DeletionPolicyRetain:
			return ctrl.Result{RequeueAfter: refreshInt}, nil
		}

  // spec:
  // target:
  //   creationPolicy: Owner
  // default로 createOrUpdate 함수가 호출된다.
  // Kubernetes secret이 없으면 생성하고, 있으면 업데이트 하게 된다.
  switch externalSecret.Spec.Target.CreationPolicy { //nolint
	case esv1beta1.CreatePolicyMerge:
		err = patchSecret(ctx, r.Client, r.Scheme, secret, mutationFunc, externalSecret.Name)
		if err == nil {
			externalSecret.Status.Binding = v1.LocalObjectReference{Name: secret.Name}
		}
	case esv1beta1.CreatePolicyNone:
		log.V(1).Info("secret creation skipped due to creationPolicy=None")
		err = nil
	default:
		err = createOrUpdate(ctx, r.Client, secret, mutationFunc, externalSecret.Name)
		if err == nil {
			externalSecret.Status.Binding = v1.LocalObjectReference{Name: secret.Name}
		}
	}

  // 마지막으로 이제 CRD에서 정의된 refreshInterval(1h) 뒤에
  // 다시 reconcilation이 된다.
  return ctrl.Result{
		RequeueAfter: refreshInt,
	}, nil
}
```

Secret manager로부터 데이터를 가져오는 `getProviderSecretData` 함수는 이제 Provider specific한 로직을 수행하게 된다. External Secret에서는 Secret Manager로 말고도 다른 Secret management tool 연동을 제공하기 때문에 이부분에서 SecretStore에 정의된 provider에 따라서 다른 로직을 수행하게 된다.

예제에서는 아래처럼 dataForm의 Array에 extract로 정의가 되어 있었다.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
spec:
  dataFrom:
    - extract:
        key: remote-key-in-the-provider
```

이 설정에 따라서 다른 로직을 수행하는데, switch문에 의해서 extract로 설정된 경우에는 `handleExtractSecrets`이 호출된다.

`externalsecret_controller_secret.go`

```go
func (r *Reconciler) getProviderSecretData(...생략) (map[string][]byte, error) {
  for i, remoteRef := range externalSecret.Spec.DataFrom {
		var secretMap map[string][]byte
		var err error

		if remoteRef.Find != nil {
			secretMap, err = r.handleFindAllSecrets(ctx, externalSecret, remoteRef, mgr, i)
		} else if remoteRef.Extract != nil {
			secretMap, err = r.handleExtractSecrets(ctx, externalSecret, remoteRef, mgr, i)
		} else if remoteRef.SourceRef != nil && remoteRef.SourceRef.GeneratorRef != nil {
			secretMap, err = r.handleGenerateSecrets(ctx, externalSecret.Namespace, remoteRef, i)
		}
}
```

함수의 로직을 확인하면 `cmgr *secretstore.Manager`을 통해서 provider의 client를 가져온다. 이제 SecretsClient의 interface로 제공하는 `GetSecretMap`을 호출하고, 이 함수에는 SecretStore에서 설정된 provider에 대한 로직이 구현되어 있다. 우리는 예제에서 Secret Manager를 사용하고 있기 때문에, Secret manager로부터 데이터를 가져오는 로직이 구현되어 있다.

`externalsecret_controller_secret.go`

```go
func (r *Reconciler) handleExtractSecrets(...생략) (map[string][]byte, error) {
  client, err := cmgr.Get(ctx, externalSecret.Spec.SecretStoreRef, externalSecret.Namespace, remoteRef.SourceRef)

  secretMap, err := client.GetSecretMap(ctx, *remoteRef.Extract)
}

```

`SecretStore`에서 정의한 provider에 맞게 SecretClient 객체를 생성하기 위해서는 아래와 같이 진행이 된다. ExternalSecret 리소스에서 secretStore에 대한 정보를 가지고 있다. 이 정보를 가지고 go-client로 `SecretStore` 리소스 정보를 가져온다.

```yaml
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: secretstore-sample
    kind: SecretStore
```

`client_manager.go`

```go
func (m *Manager) Get(...생략) (esv1beta1.SecretsClient, error) {
  store, err := m.getStore(ctx, &storeRef, namespace)
  return m.GetFromStore(ctx, store, namespace)
}

func (m *Manager) getStore(...생략) (esv1beta1.GenericStore, error) {
  ref := types.NamespacedName{
		Name: storeRef.Name,
	}

  ref.Namespace = namespace
	var store esv1beta1.SecretStore
	err := m.client.Get(ctx, ref, &store)

  return &store, nil
}
```

그 다음에는 `SecretStore` 리소스 정보를 바탕으로 적합한 provider를 선택하게 된다. 그리고 이미 해당 provider client가 호출되어 map에 저장되어 있으면 다시 사용하고, 아니면 `NewClient`로 새로 생성하여 map에 다시 저장하게 된다.

`client_manager.go`

```go
func (m *Manager) GetFromStore(...생략) (esv1beta1.SecretsClient, error) {
  storeProvider, err := esv1beta1.GetProvider(store)
	if err != nil {
		return nil, err
	}
	secretClient := m.getStoredClient(ctx, storeProvider, store)
	if secretClient != nil {
		return secretClient, nil
	}

  secretClient, err = storeProvider.NewClient(ctx, store, m.client, namespace)
	if err != nil {
		return nil, err
	}
	idx := storeKey(storeProvider)
	m.clientMap[idx] = &clientVal{
		client: secretClient,
		store:  store,
	}

  return secretClient, nil
}
```

`SecretStore`에 저장된 provider 이름으로 적합한 provider를 가져오는 것은 아래처럼 builder라는 map에서 이름으로 찾아오는 것이다. 우리는 맨 위에서 import한 package의 init 함수를 통해서 `builder`에 지원되는 provider 객체를 다 등록하였다. 여기서는 이렇게 정의된 map에서 이름으로 가져오는 작업을 하게 된다.

`provider_schema.go`

```go
func GetProvider(s GenericStore) (Provider, error) {
  buildlock.RLock()
	f, ok := builder[storeName]
	buildlock.RUnlock()

  return f, nil
}
```

`pkg/provider`경로에는 지원되는 다양한 provider에 관한 로직들이 구현되어 있다. 최종적으로 `GetSecretMap`이 호출되면 `Secret Manager`의 구현 로직에 의해서 데이터를 가져오게 된다.

`secretmanager.go`

```go
func (sm *SecretsManager) GetSecretMap(ctx context.Context, ref esv1beta1.ExternalSecretDataRemoteRef) (map[string][]byte, error) {
	log.Info("fetching secret map", "key", ref.Key)
	data, err := sm.GetSecret(ctx, ref)
	if err != nil {
		return nil, err
	}
	kv := make(map[string]json.RawMessage)
	err = json.Unmarshal(data, &kv)
	if err != nil {
		return nil, fmt.Errorf("unable to unmarshal secret %s: %w", ref.Key, err)
	}
	secretData := make(map[string][]byte)
	for k, v := range kv {
		var strVal string
		err = json.Unmarshal(v, &strVal)
		if err == nil {
			secretData[k] = []byte(strVal)
		} else {
			secretData[k] = v
		}
	}
	return secretData, nil
}
```

### SecretStore에 요청을 최소화

이렇게 Valut, AWS Secret Manager에서 secret을 관리하고, 그것이 변경되었을 때 kubernetes의 secret를 External Secret의 CRD로 업데이트해줄 수 있다. 이제 ExternalSecret kind에 대해서 Event가 생기면 그것에 대해서 Reconciler를 호출하게 된다. 그리고 기본적으로 `refreshInterval`에 설정된 시간뒤에 다시 work queue에 추가하여 다시 reconcile이 호출되도록 한다. 그러면 ExeternalSecret 생성을 할 때 `refreshInterval`마다 queue에 넣는 loop가 생기고, ExeternalSecret을 수정하면 다른 loop가 생기는 것이 아닌가? 🤔

(created event A) -> (event A after refreshInterval) -> (updated event B) -> (event A after refreshInterval) -> (event B after refreshInterval)

그래서 `shouldRefresh` 함수를 통해서 불필요하게 SecretStore에서 데이터를 가지고 오지 않는 것 같다.

`externalsecret_controller.go`

```go
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
  // refresh should be skipped if
	// 1. resource generation hasn't changed
	// 2. refresh interval is 0
	// 3. if we're still within refresh-interval
	if !shouldRefresh(externalSecret) && isSecretValid(existingSecret) {
		log.V(1).Info("skipping refresh", "rv", getResourceVersion(externalSecret))
		return ctrl.Result{RequeueAfter: refreshInt}, nil
	}
}
```

`shouldRefresh` 함수를 통해서 아래와 같이 작동한다.

1. 이전 refresh를 해서 SecretStore에서 data를 가져오고 status에 저장된 resource version이 현재 resource version과 다르면 refresh를 해야 한다. (ExternalSecret resource를 업데이트했을 때)
2. 이전에 Synced가 되었고, refreshInterval이 0으로 설정되어 있으면 refresh를 안 한다.
3. Resource의 status.RefreshTime이 0이면 refresh를 해야 한다.
4. 마지막으로 status.RefreshTime이 아직 refreshInterval만큼 경과하지 않았으면 refresh를 안 한다.

마지막 4번째가 work queue에 enqueue를 계속 하는 loop가 두 개 이상 생길 수 있기 때문에, status.RefreshTime을 체크해서 다시 SecretStore에서 가져오지 않는 것으로 해결한 것인가?

`externalsecret_controller.go`

```go
func shouldRefresh(es esv1beta1.ExternalSecret) bool {
	// refresh if resource version changed
	if es.Status.SyncedResourceVersion != getResourceVersion(es) {
		return true
	}

	// skip refresh if refresh interval is 0
	if es.Spec.RefreshInterval.Duration == 0 && es.Status.SyncedResourceVersion != "" {
		return false
	}
	if es.Status.RefreshTime.IsZero() {
		return true
	}
	return es.Status.RefreshTime.Add(es.Spec.RefreshInterval.Duration).Before(time.Now())
}
```

### Immutable Secret

코드를 보다 보니 ExternalSecret의 spec에서 Immutable 설정을 하면, Kubernetes secret resource를 immutable true로 생성한다. 그리고 다음 reconcile에서 이미 한번 sync한 secret에 대해서는 더 이상 reconcile을 하지 않는 것으로 Immutable을 적용하고 있다.

`externalsecret_controller.go`

```go
if !shouldReconcile(externalSecret) {
  log.V(1).Info("stopping reconciling", "rv", getResourceVersion(externalSecret))
  return ctrl.Result{
    RequeueAfter: 0,
    Requeue:      false,
  }, nil
}

secret := &v1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      secretName,
			Namespace: externalSecret.Namespace,
		},
		Immutable: &externalSecret.Spec.Target.Immutable,
		Data:      make(map[string][]byte),
	}
```

```go
func shouldReconcile(es esv1beta1.ExternalSecret) bool {
	if es.Spec.Target.Immutable && hasSyncedCondition(es) {
		return false
	}
	return true
}
```

```yaml
apiVersion: v1
kind: Secret
metadata: ...
data: ...
immutable: true
```

### OwnerReferces

소스코드를 보기 전에 CRD에서 `CreationPolicy`의 Owner 설정이 어떤 역할을 하는지 살펴보았다. 이부분은 아래처럼 CreationPolicy가 `Owner`이면, Metadata의 OwnerReferce를 설정하게 됩니다.

`externalsecret_controller.go`

```go
mutationFunc := func() error {
		if externalSecret.Spec.Target.CreationPolicy == esv1beta1.CreatePolicyOwner {
			err = controllerutil.SetControllerReference(&externalSecret, &secret.ObjectMeta, r.Scheme)
			if err != nil {
				return fmt.Errorf(errSetCtrlReference, err)
			}
		}
}
```

`controllerutil.go`

```go
func SetControllerReference(owner, controlled metav1.Object, scheme *runtime.Scheme) error {
	ref := metav1.OwnerReference{
		APIVersion:         gvk.GroupVersion().String(),
		Kind:               gvk.Kind,
		Name:               owner.GetName(),
		UID:                owner.GetUID(),
		BlockOwnerDeletion: pointer.Bool(true),
		Controller:         pointer.Bool(true),
	}
}
```

### Validator

calico에서는 calico apiserver를 통해서 kubectl로 resource를 생성할 때, defaulting과 validation을 할 수가 있다. 아니면 calicoctl command tool을 통해서 calico apiserver 없이 resource를 생성할 때 동일한 defaulting과 validation을 할수가 있다. [kubebuilder에서 defaulting/validating webhook을 적용](https://book.kubebuilder.io/cronjob-tutorial/webhook-implementation.html)하는 것을 살펴보면, External Secret에서는 `apis/externalsecrets`안에 `externalsecret_validator.go`로 정의되어 있을 것을 볼 수 있다. `CREATE`, `UPDATE` 하는 경우에는 `validateExternalSecret` 함수를 호출하여 validating을 하고 있다.

`externalsecret_validator.go`

```go
func (esv *ExternalSecretValidator) ValidateCreate(_ context.Context, obj runtime.Object) (admission.Warnings, error) {
	return validateExternalSecret(obj)
}

func (esv *ExternalSecretValidator) ValidateUpdate(_ context.Context, _, newObj runtime.Object) (admission.Warnings, error) {
	return validateExternalSecret(newObj)
}

func (esv *ExternalSecretValidator) ValidateDelete(_ context.Context, _ runtime.Object) (admission.Warnings, error) {
	return nil, nil
}

func validateExternalSecret(obj runtime.Object) (admission.Warnings, error) {
	es, ok := obj.(*ExternalSecret)
	if !ok {
		return nil, fmt.Errorf("unexpected type")
	}

	if (es.Spec.Target.DeletionPolicy == DeletionPolicyDelete && es.Spec.Target.CreationPolicy == CreatePolicyMerge) ||
		(es.Spec.Target.DeletionPolicy == DeletionPolicyDelete && es.Spec.Target.CreationPolicy == CreatePolicyNone) {
		return nil, fmt.Errorf("deletionPolicy=Delete must not be used when the controller doesn't own the secret. Please set creationPolcy=Owner")
	}

	if es.Spec.Target.DeletionPolicy == DeletionPolicyMerge && es.Spec.Target.CreationPolicy == CreatePolicyNone {
		return nil, fmt.Errorf("deletionPolicy=Merge must not be used with creationPolcy=None. There is no Secret to merge with")
	}

	for _, ref := range es.Spec.DataFrom {
		findOrExtract := ref.Find != nil || ref.Extract != nil
		if findOrExtract && ref.SourceRef != nil && ref.SourceRef.GeneratorRef != nil {
			return nil, fmt.Errorf("generator can not be used with find or extract")
		}
	}

	return nil, nil
}
```

이제 이렇게 validating을 추가하여 DeletionPolicy가 Delete로 CreatePolicy가 Merge로 동시에 설정되지 못하도록 하였다. ExternalSecret Kind에서 SecretStore를 ref값으로 가리키도록 하고 있다. 하지만 ExternalSecret의 `secretStoreRef`가 유효한 값인지는 validating에서 체크하지 않는다. 이부분에 대해서 추가하면 좋지 않을까?

## 다른 기능

### PushSecret

이렇게 Valut, AWS Secret Manager에서 secret을 관리하고, 그것이 변경되었을 때 kubernetes의 secret를 External Secret의 CRD로 업데이트해줄 수 있다. `PushSecret`라는 kind는 이제 반대로 Kubernetes secret을 SecretStore에 업데이트하는 것을 할 수 있다.

```yaml
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: pushsecret-example # Customisable
  namespace: default # Same of the SecretStores
spec:
  refreshInterval: 10s
```

### Generator

몇가지 secret value들을 생성할 수 있는 CRD를 제공한다. 예를 들어서 Vault Dynamic Secret를 이용해서 값을 생성하려면 아래처럼 별도의 Custom Resource를 만들고, External Secret에 `generatorRef`로 정의해준다.

```yaml
apiVersion: generators.external-secrets.io/v1alpha1
kind: VaultDynamicSecret
metadata:
  name: 'pki-example'
spec:
  path: '/pki/issue/example-dot-com'
  method: 'POST'
  parameters:
    common_name: 'localhost'
    ip_sans: '127.0.0.1,127.0.0.11'
  provider:
    server: 'http://vault.default.svc.cluster.local:8200'
    auth:
      kubernetes:
        mountPath: 'kubernetes'
        role: 'external-secrets-operator'
        serviceAccountRef:
          name: 'default'
```

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: 'pki-example-com'
spec:
  refreshInterval: '768h'
  target:
    name: pki-example-com
  dataFrom:
    - sourceRef:
        generatorRef:
          apiVersion: generators.external-secrets.io/v1alpha1
          kind: VaultDynamicSecret
          name: 'pki-example'
```

## 결론

외부 Secret management tool과 Kubernetes Secret의 Sync 맞추기 위해서 CRD와 Custom controller로 해결한 External Secrets 프로젝트의 코드를 살펴보게 되었다. CRD에 정의된 `refreshInterval` 시간마다 Polling 방식으로 외부 secret management tool의 값을 가져오고, Kubernetes secret 리소스와 sync를 하게 된다. 반복되는 loop을 만들기 위해서 로직이 정상적으로 수행하고 나면, work queue에 `refreshInterval`이 경과한 뒤 enqueue하도록 Result를 반환한다. 그리고 Custom Resource Status의 RefreshTime을 보고 아직 `refreshInterval`이 경과하지 않았으면 Secret management tool에 요청하지 않는다. 하지만 외부 Secret management tool와 sync가 빨리 되도록 `refreshInterval`을 짧게 설정하면 네트워크 요청이 더 빈번하게 발생하게 되고, ExternalSecret custom resource가 많아 질수록 이러한 네트워크 요청은 더 많아지게 될 것이다. 쿠버네티스에서 Informer를 통해서 처음에 List를 해오고 캐시와 Watch를 통해서 변화되는 Event에만 로직을 수행할 수 있는데, 이렇게 Polling 방식은 확장성에서 문제가 있다는 생각이 들었다.
