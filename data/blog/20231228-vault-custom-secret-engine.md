---
title: 'Vault custom secret engine 작성해보기'
date: '2023-12-28'
tags: [vault]
images: ['/static/images/social-banner.png']
summary: 'Vault의 secret engine을 사용하여 네이버 클라우드의 임시 인증키를 발행하고 싶었다. 네이버클라우드는 AWS, Azure처럼 builtin plugin으로 제공하지 않는다. 하지만 custom secret engine을 vault framework SDK를 통해서 쉽게 만들 수 있다. 네이버 클라우드에서 STS API를 제공하기 때문에, custom secret engine을 통해서 임시 인증키를 발행하는 것을 테스트 해보게 되었다. 처음에 구조를 이해하는데 좀 시간이 걸렸지만, Vault Tutorial에서 친절하게 설명하고 있어서 비교적 쉽게 만들 수 있었다.'
---

## 동기

Vault에서 제공하는 [AWS secrets engine](https://developer.hashicorp.com/vault/docs/secrets/aws)처럼 네이버 클라우드의 인증키를 Vault를 통해서 관리하고 싶었다. 일단 가능성을 검토했을 때 [네이버 클라우드에서 STS API](https://api-gov.ncloud-docs.com/docs/management-sts-creatests)를 제공하고 있고, [Vault의 custom engine Tutorial](https://developer.hashicorp.com/vault/tutorials/custom-secrets-engine)에서 친절하게 custom engine을 만드는 과정을 설명하고 있었다. 그래서 충분히 쉽게 만들어 볼 수 있을 것이라는 생각이 들었다.

## 네이버 클라우드 STS API 테스트

먼저 인증키로 STS 생성하는 것을 Go로 테스트해보았다. [Ncloud API 문서](https://api-gov.ncloud-docs.com/docs/common-ncpapi-ncpapi)에서 친절하게 어떻게 signature를 만들어서 header로 보내야하는지 설명하고 있다. 하지만 Go로는 작성된 예가 없어서 직접 작성해보았다. [ncloud-sdk-go-v2](https://github.com/NaverCloudPlatform/ncloud-sdk-go-v2)도 있기 때문에 그냥 sdk를 사용해도 되겠다.

```bash
go run main.go
```

`main.go`

```go
package main

import (
	"bytes"
	b64 "encoding/base64"
	"crypto/hmac"
	"crypto"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"time"
	"strconv"
	"io/ioutil"
)

func makeSignature(accessKey string, secretKey string, url string, method string, timestamp string) (string, error) {
	space := " "
	newLine := "\n"
	mac := hmac.New(crypto.SHA256.New, []byte(secretKey))
	mac.Write([]byte(method))
	mac.Write([]byte(space))
	mac.Write(([]byte(url)))
	mac.Write([]byte(newLine))
	mac.Write([]byte(timestamp))
	mac.Write([]byte(newLine))
	mac.Write([]byte(accessKey))

	hash := mac.Sum((nil))
	encodedHash := b64.StdEncoding.EncodeToString(hash)
	return encodedHash, nil
}

func main() {
	timestamp := strconv.FormatInt(time.Now().UnixNano()/int64(time.Millisecond), 10)
	secretKey := os.Getenv("SECRET_KEY")
	accessKey := os.Getenv("ACCESS_KEY")
	fmt.Printf("accessKey: %s\n", accessKey)
	url, err := url.Parse("https://sts.apigw.gov-ntruss.com/api/v1/credentials")
	if err != nil {
		fmt.Printf("failed to parse url: %s\n", err);
		os.Exit(1)
	}
	sig, err := makeSignature(accessKey, secretKey, "/api/v1/credentials", "POST", timestamp)
	if err != nil {
		fmt.Printf("failed to create signature: %s\n", err);
		os.Exit(1)
	}
	fmt.Printf("sig: %s\n", sig)
	jsonBody := []byte(`{"durationSec": 3600}`)
 	bodyReader := bytes.NewReader(jsonBody)

	req, err := http.NewRequest(http.MethodPost, url.String(), bodyReader)
  if err != nil {
		 fmt.Printf("client: could not create request: %s\n", err)
		 os.Exit(1)
  }
  req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-ncp-apigw-timestamp", timestamp)
	req.Header.Set("x-ncp-iam-access-key", accessKey)
	req.Header.Set("x-ncp-apigw-signature-v2", sig)

  client := http.Client{
	 Timeout: 30 * time.Second,
  }
	res, err := client.Do(req)
  if err != nil {
	  fmt.Printf("client: error making http request: %s\n", err)
	  os.Exit(1)
  }

	fmt.Printf("client: %d\n", res.StatusCode)
	resBody, err := ioutil.ReadAll(res.Body)
	if err != nil {
		fmt.Printf("client: could not read response body: %s\n", err)
		os.Exit(1)
	}
	fmt.Printf("client: response body: %s\n", resBody)
}
```

## Custom Engine Tutorial

[custom secret engine을 만드는 Tutorial 문서](https://developer.hashicorp.com/vault/tutorials/custom-secrets-engine)을 쭉 읽으면서 어떤 구조로 되었는지 파악을 했다. Tutorial에서는 서버에 username과 password로 로그인을 하면 token을 받을 수 있는 API와(Sign up), 발급된 token을 revoke할 수 있는 API(Sign out)가 존재할 때, Token 발급/폐기를 vault로 관리할 수 있도록 custom secret engine을 작성하는 것을 설명한다.

- valut의 custom secret engine에 username, password, URL을 저장
- vault에서 role을 생성
- vault에서 credential을 읽으면 서버 API로 발급한 token 값을 확인
- vault에서 revoke하면 서버 API에 호출하여 token을 폐기

위의 로직을 아래처럼 수정하였다.

- vault의 custom secret engine에 accessKey와 secretKey를 저장
- vault에서 role을 생성
- vault에서 credential을 읽을 때 네이버 클라우드 STS API에 임시 인증키를 요청함
- STS 만료기간이 끝나면 자동 폐기되고, 따로 폐기하는 API가 없기 때문에 revoke 코드는 제거

해당 tutorial의 [client source code](https://github.com/hashicorp-demoapp/hashicups-client-go)와 [plugin source code](https://github.com/hashicorp-education/learn-vault-plugin-secrets-hashicups)을 참고하여 아래와 같이 작성을 했다.

`backend.go`

```go
package secretsengine

import (
	"context"
	"strings"
	"sync"

	"github.com/hashicorp/vault/sdk/framework"
	"github.com/hashicorp/vault/sdk/logical"
)

func Factory(ctx context.Context, conf *logical.BackendConfig) (logical.Backend, error) {
	b := backend()
	if err := b.Setup(ctx, conf); err != nil {
		return nil, err
	}
	return b, nil
}

type ncloudBackend struct {
	*framework.Backend
	lock sync.RWMutex
	client *Client
}

func backend() *ncloudBackend {
	var b = ncloudBackend{}

	b.Backend = &framework.Backend{
		Help: strings.TrimSpace(backendHelp),
		PathsSpecial: &logical.Paths{
			LocalStorage: []string{},
			SealWrapStorage: []string{
				"config",
				"role/*",
			},
		},
		Paths: framework.PathAppend(
			pathRole(&b),
			[]*framework.Path{
				pathConfig(&b),
				pathCredentials(&b),
			},
		),
		Secrets: []*framework.Secret{
			b.ncloudKey(),
		},
		BackendType: logical.TypeLogical,
		Invalidate:  b.invalidate,
	}
	return &b
}

func (b *ncloudBackend) reset() {
	b.lock.Lock()
	defer b.lock.Unlock()
	b.client = nil
}

func (b *ncloudBackend) invalidate(ctx context.Context, key string) {
	if key == "config" {
		b.reset()
	}
}

func (b *ncloudBackend) getClient(ctx context.Context, s logical.Storage) (*Client, error) {
	b.lock.RLock()
	unlockFunc := b.lock.RUnlock
	defer func() { unlockFunc() }()

	if b.client != nil {
		return b.client, nil
	}

	b.lock.RUnlock()
	b.lock.Lock()
	unlockFunc = b.lock.Unlock

	config, err := getConfig(ctx, s)
	if err != nil {
		return nil, err
	}

	if config == nil {
		config = new(ncloudConfig)
	}

	b.client, err = newClient(config)
	if err != nil {
		return nil, err
	}

	return b.client, nil
}

const backendHelp = `
The HashiCups secrets backend dynamically generates user tokens.
After mounting this backend, credentials to manage HashiCups user tokens
must be configured with the "config/" endpoints.
`
```

`client.go`

```go
package secretsengine

import (
	"fmt"
	"errors"
	"bytes"
	b64 "encoding/base64"
	"crypto/hmac"
	"crypto"
	"net/http"
	"encoding/json"
	"time"
	"strconv"
	"io/ioutil"
)

func newClient(config *ncloudConfig) (*Client, error) {
	if config == nil {
		return nil, errors.New("client configuration was nil")
	}

	if config.AccessKey == "" {
		return nil, errors.New("client accessKey was not defined")
	}

	if config.KeySecret == "" {
		return nil, errors.New("client keySecret was not defined")
	}

	c := Client{
		HTTPClient: &http.Client{Timeout: 10 * time.Second},
		HostURL: HostURL,
	}

	c.Auth = AuthStruct{
		AccessKey: config.AccessKey,
		KeySecret: config.KeySecret,
	}

	_, err := c.getTokenFromSTS(900)
	if err != nil {
		return nil, err
	}

	return &c, nil
}

const HostURL string = "https://sts.apigw.gov-ntruss.com/api/v1/credentials"

type Client struct {
	HostURL string
	HTTPClient *http.Client
	Auth AuthStruct
}

type AuthStruct struct {
	AccessKey string `json:"accessKey"`
	KeySecret string `json:"keySecret"`
}

type AuthRequest struct {
	DurationSec int `json:"durationSec"`
}

type AuthResponse struct {
	AccessKey string `json:"accessKey"`
	KeySecret string `json:"keySecret"`
	CreateTime string `json:"createTime"`
	ExpireTime string `json:"expireTime"`
	UseMfa bool `json:"useMfa"`
}

func (c *Client) getTokenFromSTS(ttl int) (*AuthResponse, error) {
	timestamp := strconv.FormatInt(time.Now().UnixNano()/int64(time.Millisecond), 10)
	sig, err := makeSignature(c.Auth.AccessKey, c.Auth.KeySecret, "/api/v1/credentials", "POST", timestamp)
	if err != nil {
		return nil, err
	}
	data := AuthRequest{
		DurationSec: 900,
	}
	jsonBody, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
 	bodyReader := bytes.NewReader(jsonBody)

	req, err := http.NewRequest(http.MethodPost, c.HostURL, bodyReader)
  if err != nil {
		return nil, err
  }
  req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-ncp-apigw-timestamp", timestamp)
	req.Header.Set("x-ncp-iam-access-key", c.Auth.AccessKey)
	req.Header.Set("x-ncp-apigw-signature-v2", sig)

  client := http.Client{
	 Timeout: 30 * time.Second,
  }
	res, err := client.Do(req)
  if err != nil {
	  return nil, err
  }
	defer res.Body.Close()

	resBody, err := ioutil.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}

	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status: %d, body: %s", res.StatusCode, resBody)
	}

	ar := AuthResponse{}
	err = json.Unmarshal(resBody, &ar)
	if err != nil {
		return nil, err
	}

	return &ar, nil
}

func makeSignature(accessKey string, secretKey string, url string, method string, timestamp string) (string, error) {
	space := " "
	newLine := "\n"
	mac := hmac.New(crypto.SHA256.New, []byte(secretKey))
	mac.Write([]byte(method))
	mac.Write([]byte(space))
	mac.Write(([]byte(url)))
	mac.Write([]byte(newLine))
	mac.Write([]byte(timestamp))
	mac.Write([]byte(newLine))
	mac.Write([]byte(accessKey))

	hash := mac.Sum((nil))
	encodedHash := b64.StdEncoding.EncodeToString(hash)
	return encodedHash, nil
}
```

`ncloud_key.go`

```go
package secretsengine

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/hashicorp/vault/sdk/framework"
	"github.com/hashicorp/vault/sdk/logical"
)

const (
	ncloudKeyType = "ncloud_sts_key"
)

type ncloudSTSTKey struct {
	KeyID  string `json:"key_id"`
	AccessKey    string `json:"access_key"`
	KeyScret    string `json:"key_secret"`
}

func (b *ncloudBackend) ncloudKey() *framework.Secret {
	return &framework.Secret{
		Type: ncloudKeyType,
		Fields: map[string]*framework.FieldSchema{
			"key": {
				Type:        framework.TypeString,
				Description: "ncloud STS Key",
			},
		},
		Renew:  b.keyRenew,
	}
}

func (b *ncloudBackend) keyRenew(ctx context.Context, req *logical.Request, d *framework.FieldData) (*logical.Response, error) {
	roleRaw, ok := req.Secret.InternalData["role"]
	if !ok {
		return nil, fmt.Errorf("secret is missing role internal data")
	}

	role := roleRaw.(string)
	roleEntry, err := b.getRole(ctx, req.Storage, role)
	if err != nil {
		return nil, fmt.Errorf("error retrieving role: %w", err)
	}

	if roleEntry == nil {
		return nil, errors.New("error retrieving role: role is nil")
	}

	resp := &logical.Response{Secret: req.Secret}

	if roleEntry.TTL > 0 {
		resp.Secret.TTL = roleEntry.TTL
	}
	if roleEntry.MaxTTL > 0 {
		resp.Secret.MaxTTL = roleEntry.MaxTTL
	}

	return resp, nil
}

func createKey(ctx context.Context, c *Client, ttl int) (*ncloudSTSTKey, error) {
	response, err := c.getTokenFromSTS(ttl)
	if err != nil {
		return nil, fmt.Errorf("error creating HashiCups token: %w", err)
	}

	keyID := uuid.New().String()

	return &ncloudSTSTKey{
		KeyID:   keyID,
		AccessKey: response.AccessKey,
		KeyScret: response.KeySecret,
	}, nil
}
```

`path_config.go`

```go
package secretsengine

import (
	"context"
	"errors"
	"fmt"

	"github.com/hashicorp/vault/sdk/framework"
	"github.com/hashicorp/vault/sdk/logical"
)

const (
	configStoragePath = "config"
)

type ncloudConfig struct {
	AccessKey string `json:"accessKey"`
	KeySecret string `json:"keySecret"`
}

func pathConfig(b *ncloudBackend) *framework.Path {
	return &framework.Path{
		Pattern: "config",
		Fields: map[string]*framework.FieldSchema{
			"accessKey": {
				Type:        framework.TypeString,
				Description: "The accessKey to access Naver Cloud",
				Required:    true,
				DisplayAttrs: &framework.DisplayAttributes{
					Name:      "AccessKey",
					Sensitive: false,
				},
			},
			"keySecret": {
				Type:        framework.TypeString,
				Description: "The keySecret to access Naver Cloud",
				Required:    true,
				DisplayAttrs: &framework.DisplayAttributes{
					Name:      "KeySecret",
					Sensitive: true,
				},
			},
		},
		Operations: map[logical.Operation]framework.OperationHandler{
			logical.ReadOperation: &framework.PathOperation{
				Callback: b.pathConfigRead,
			},
			logical.CreateOperation: &framework.PathOperation{
				Callback: b.pathConfigWrite,
			},
			logical.UpdateOperation: &framework.PathOperation{
				Callback: b.pathConfigWrite,
			},
			logical.DeleteOperation: &framework.PathOperation{
				Callback: b.pathConfigDelete,
			},
		},
		ExistenceCheck:  b.pathConfigExistenceCheck,
		HelpSynopsis:    pathConfigHelpSynopsis,
		HelpDescription: pathConfigHelpDescription,
	}
}

func (b *ncloudBackend) pathConfigExistenceCheck(ctx context.Context, req *logical.Request, data *framework.FieldData) (bool, error) {
	out, err := req.Storage.Get(ctx, req.Path)
	if err != nil {
		return false, fmt.Errorf("existence check failed: %w", err)
	}

	return out != nil, nil
}

func (b *ncloudBackend) pathConfigRead(ctx context.Context, req *logical.Request, data *framework.FieldData) (*logical.Response, error) {
	config, err := getConfig(ctx, req.Storage)
	if err != nil {
		return nil, err
	}

	return &logical.Response{
		Data: map[string]interface{}{
			"accessKey": config.AccessKey,
		},
	}, nil
}

func (b *ncloudBackend) pathConfigWrite(ctx context.Context, req *logical.Request, data *framework.FieldData) (*logical.Response, error) {
	config, err := getConfig(ctx, req.Storage)
	if err != nil {
		return nil, err
	}

	createOperation := (req.Operation == logical.CreateOperation)

	if config == nil {
		if !createOperation {
			return nil, errors.New("config not found during update operation")
		}
		config = new(ncloudConfig)
	}

	if accessKey, ok := data.GetOk("accessKey"); ok {
		config.AccessKey = accessKey.(string)
	} else if !ok && createOperation {
		return nil, fmt.Errorf("missing accessKey in configuration")
	}

	if keySecret, ok := data.GetOk("keySecret"); ok {
		config.KeySecret = keySecret.(string)
	} else if !ok && createOperation {
		return nil, fmt.Errorf("missing keySecret in configuration")
	}

	entry, err := logical.StorageEntryJSON(configStoragePath, config)
	if err != nil {
		return nil, err
	}

	if err := req.Storage.Put(ctx, entry); err != nil {
		return nil, err
	}

	b.reset()

	return nil, nil
}

func (b *ncloudBackend) pathConfigDelete(ctx context.Context, req *logical.Request, data *framework.FieldData) (*logical.Response, error) {
	err := req.Storage.Delete(ctx, configStoragePath)

	if err == nil {
		b.reset()
	}

	return nil, err
}

func getConfig(ctx context.Context, s logical.Storage) (*ncloudConfig, error) {
	entry, err := s.Get(ctx, configStoragePath)
	if err != nil {
		return nil, err
	}

	if entry == nil {
		return nil, nil
	}

	config := new(ncloudConfig)
	if err := entry.DecodeJSON(&config); err != nil {
		return nil, fmt.Errorf("error reading root configuration: %w", err)
	}

	return config, nil
}

const pathConfigHelpSynopsis = `Configure the HashiCups backend.`

const pathConfigHelpDescription = `
The HashiCups secret backend requires credentials for managing
JWTs issued to users working with the products API.

You must sign up with a username and password and
specify the HashiCups address for the products API
before using this secrets backend.
`
```

`path_credentials.go`

```go
package secretsengine

import (
	"context"
	"errors"
	"fmt"

	"github.com/hashicorp/vault/sdk/framework"
	"github.com/hashicorp/vault/sdk/logical"
)

func pathCredentials(b *ncloudBackend) *framework.Path {
	return &framework.Path{
		Pattern: "creds/" + framework.GenericNameRegex("name"),
		Fields: map[string]*framework.FieldSchema{
			"name": {
				Type:        framework.TypeLowerCaseString,
				Description: "Name of the role",
				Required:    true,
			},
		},
		Callbacks: map[logical.Operation]framework.OperationFunc{
			logical.ReadOperation:   b.pathCredentialsRead,
			logical.UpdateOperation: b.pathCredentialsRead,
		},
		HelpSynopsis:    pathCredentialsHelpSyn,
		HelpDescription: pathCredentialsHelpDesc,
	}
}

func (b *ncloudBackend) pathCredentialsRead(ctx context.Context, req *logical.Request, d *framework.FieldData) (*logical.Response, error) {
	roleName := d.Get("name").(string)

	roleEntry, err := b.getRole(ctx, req.Storage, roleName)
	if err != nil {
		return nil, fmt.Errorf("error retrieving role: %w", err)
	}

	if roleEntry == nil {
		return nil, errors.New("error retrieving role: role is nil")
	}

	return b.createUserCreds(ctx, req, roleEntry)
}

func (b *ncloudBackend) createUserCreds(ctx context.Context, req *logical.Request, role *ncloudRoleEntry) (*logical.Response, error) {
	key, err := b.createKey(ctx, req.Storage, role)
	if err != nil {
		return nil, err
	}

	resp := b.Secret(ncloudKeyType).Response(map[string]interface{}{
		"key_id":   key.KeyID,
		"access_key": key.AccessKey,
		"key_secret": key.KeyScret,
	}, map[string]interface{}{
		"access_key": key.AccessKey,
	})

	if role.TTL > 0 {
		resp.Secret.TTL = role.TTL
	}

	if role.MaxTTL > 0 {
		resp.Secret.MaxTTL = role.MaxTTL
	}

	return resp, nil
}

func (b *ncloudBackend) createKey(ctx context.Context, s logical.Storage, roleEntry *ncloudRoleEntry) (*ncloudSTSTKey, error) {
	client, err := b.getClient(ctx, s)
	if err != nil {
		return nil, err
	}

	var key *ncloudSTSTKey

	key, err = createKey(ctx, client, int(roleEntry.TTL))
	if err != nil {
		return nil, fmt.Errorf("error creating ncloud STS key: %w", err)
	}

	if key == nil {
		return nil, errors.New("error creating ncloud STS key")
	}

	return key, nil
}

const pathCredentialsHelpSyn = `
Generate a HashiCups API token from a specific Vault role.
`

const pathCredentialsHelpDesc = `
This path generates a HashiCups API user tokens
based on a particular role. A role can only represent a user token,
since HashiCups doesn't have other types of tokens.
`
```

`path_roles.go`

```go
package secretsengine

import (
	"context"
	"fmt"
	"time"

	"github.com/hashicorp/vault/sdk/framework"
	"github.com/hashicorp/vault/sdk/logical"
)

type ncloudRoleEntry struct {
	TTL      time.Duration `json:"ttl"`
	MaxTTL   time.Duration `json:"max_ttl"`
}

func (r *ncloudRoleEntry) toResponseData() map[string]interface{} {
	respData := map[string]interface{}{
		"ttl":      r.TTL.Seconds(),
		"max_ttl":  r.MaxTTL.Seconds(),
		// "username": r.Username,
	}
	return respData
}

func pathRole(b *ncloudBackend) []*framework.Path {
	return []*framework.Path{
		{
			Pattern: "role/" + framework.GenericNameRegex("name"),
			Fields: map[string]*framework.FieldSchema{
				"name": {
					Type:        framework.TypeLowerCaseString,
					Description: "Name of the role",
					Required:    true,
				},
				"ttl": {
					Type:        framework.TypeDurationSecond,
					Description: "Default lease for generated credentials. If not set or set to 0, will use system default.",
				},
				"max_ttl": {
					Type:        framework.TypeDurationSecond,
					Description: "Maximum time for role. If not set or set to 0, will use system default.",
				},
			},
			Operations: map[logical.Operation]framework.OperationHandler{
				logical.ReadOperation: &framework.PathOperation{
					Callback: b.pathRolesRead,
				},
				logical.CreateOperation: &framework.PathOperation{
					Callback: b.pathRolesWrite,
				},
				logical.UpdateOperation: &framework.PathOperation{
					Callback: b.pathRolesWrite,
				},
				logical.DeleteOperation: &framework.PathOperation{
					Callback: b.pathRolesDelete,
				},
			},
			HelpSynopsis:    pathRoleHelpSynopsis,
			HelpDescription: pathRoleHelpDescription,
		},
		{
			Pattern: "role/?$",
			Operations: map[logical.Operation]framework.OperationHandler{
				logical.ListOperation: &framework.PathOperation{
					Callback: b.pathRolesList,
				},
			},
			HelpSynopsis:    pathRoleListHelpSynopsis,
			HelpDescription: pathRoleListHelpDescription,
		},
	}
}

func (b *ncloudBackend) pathRolesList(ctx context.Context, req *logical.Request, d *framework.FieldData) (*logical.Response, error) {
	entries, err := req.Storage.List(ctx, "role/")
	if err != nil {
		return nil, err
	}

	return logical.ListResponse(entries), nil
}

func (b *ncloudBackend) pathRolesRead(ctx context.Context, req *logical.Request, d *framework.FieldData) (*logical.Response, error) {
	entry, err := b.getRole(ctx, req.Storage, d.Get("name").(string))
	if err != nil {
		return nil, err
	}

	if entry == nil {
		return nil, nil
	}

	return &logical.Response{
		Data: entry.toResponseData(),
	}, nil
}

func (b *ncloudBackend) pathRolesWrite(ctx context.Context, req *logical.Request, d *framework.FieldData) (*logical.Response, error) {
	name, ok := d.GetOk("name")
	if !ok {
		return logical.ErrorResponse("missing role name"), nil
	}

	roleEntry, err := b.getRole(ctx, req.Storage, name.(string))
	if err != nil {
		return nil, err
	}

	if roleEntry == nil {
		roleEntry = &ncloudRoleEntry{}
	}

	createOperation := (req.Operation == logical.CreateOperation)

	if ttlRaw, ok := d.GetOk("ttl"); ok {
		roleEntry.TTL = time.Duration(ttlRaw.(int)) * time.Second
	} else if createOperation {
		roleEntry.TTL = time.Duration(d.Get("ttl").(int)) * time.Second
	}

	if maxTTLRaw, ok := d.GetOk("max_ttl"); ok {
		roleEntry.MaxTTL = time.Duration(maxTTLRaw.(int)) * time.Second
	} else if createOperation {
		roleEntry.MaxTTL = time.Duration(d.Get("max_ttl").(int)) * time.Second
	}

	if roleEntry.MaxTTL != 0 && roleEntry.TTL > roleEntry.MaxTTL {
		return logical.ErrorResponse("ttl cannot be greater than max_ttl"), nil
	}

	if err := setRole(ctx, req.Storage, name.(string), roleEntry); err != nil {
		return nil, err
	}

	return nil, nil
}

func (b *ncloudBackend) pathRolesDelete(ctx context.Context, req *logical.Request, d *framework.FieldData) (*logical.Response, error) {
	err := req.Storage.Delete(ctx, "role/"+d.Get("name").(string))
	if err != nil {
		return nil, fmt.Errorf("error deleting hashiCups role: %w", err)
	}

	return nil, nil
}

func setRole(ctx context.Context, s logical.Storage, name string, roleEntry *ncloudRoleEntry) error {
	entry, err := logical.StorageEntryJSON("role/"+name, roleEntry)
	if err != nil {
		return err
	}

	if entry == nil {
		return fmt.Errorf("failed to create storage entry for role")
	}

	if err := s.Put(ctx, entry); err != nil {
		return err
	}

	return nil
}

func (b *ncloudBackend) getRole(ctx context.Context, s logical.Storage, name string) (*ncloudRoleEntry, error) {
	if name == "" {
		return nil, fmt.Errorf("missing role name")
	}

	entry, err := s.Get(ctx, "role/"+name)
	if err != nil {
		return nil, err
	}

	if entry == nil {
		return nil, nil
	}

	var role ncloudRoleEntry

	if err := entry.DecodeJSON(&role); err != nil {
		return nil, err
	}
	return &role, nil
}

const (
	pathRoleHelpSynopsis    = `Manages the Vault role for generating HashiCups tokens.`
	pathRoleHelpDescription = `
This path allows you to read and write roles used to generate HashiCups tokens.
You can configure a role to manage a user's token by setting the username field.
`

	pathRoleListHelpSynopsis    = `List the existing roles in HashiCups backend`
	pathRoleListHelpDescription = `Roles will be listed by the role name.`
)

```

일단 테스트코드는 무시하고 아래와 같이 binary 파일을 만든다.

```bash
go build -o ./vault/plugins/vault-plugin-secrets-ncloud  ./cmd/vault-plugin-secrets-ncloud/main.go
```

해당 binary 값이 있는 경로를 vault server config에 설정한다.

```bash
cat > vault/server.hcl << EOF
plugin_directory = "$(pwd)/vault/plugins"
api_addr         = "http://127.0.0.1:8200"

storage "inmem" {}

listener "tcp" {
  address     = "127.0.0.1:8200"
  tls_disable = "true"
}
EOF
```

vault를 실행해서 role까지 새성한다.

```bash
vault server -config=./vault/server.hcl
vault operator init -key-shares=1 -key-threshold=1
vault operator unseal {key}
vault login
SHA256=$(shasum -a 256 vault/plugins/vault-plugin-secrets-ncloud | cut -d ' ' -f1)
vault plugin register -sha256=$SHA256 secret vault-plugin-secrets-ncloud
vault secrets enable -path=ncloud vault-plugin-secrets-ncloud
vault write ncloud/config accessKey={accessKey} keySecret={keySecret}
vault write ncloud/role/test ttl=1000
```

마지막으로 STS에서 생선된 인증키가 정상적으로 나오는 것을 확인한다.

```bash
$ vault read ncloud/creds/test
Key                Value
---                -----
lease_id           ncloud/creds/test/kjuY39pQMS3zNqQQyffg38dt
lease_duration     16m40s
lease_renewable    true
access_key         {access_key from STS}
key_id             28f24b3f-bb35-499d-acda-7c9164012d2e
key_secret         {key_secert from STS}
```

## 결론

친절하게 Vault 공식 문서에서 custom secret engine을 만드는 것을 잘 설명하고 있다. 처음에 구조를 이해하는데 좀 시간이 걸렸지만, 그래도 반나절 정도 시간을 들여서 vault custom secret engine을 통해서 네이버 클라우드 임시 인증키를 발급해볼 수 있었다. 아직 덜 이해된 부분도 더 이해해서 수정하고, 테스트코드도 작성하여 github에 올리는 작업을 해야겠다.🤓
