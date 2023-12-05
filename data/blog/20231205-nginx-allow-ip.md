---
title: 'Kubernetes에서 Nginx로 IP allow list 제어'
date: '2023-11-22'
tags: [Kubernetes, Nginx]
images: ['/static/images/social-banner.png']
summary: 'Kubernetes cluster에서 Nginx로 허용 가능한 IP를 설정하고 싶었다. 간단하게 끝날 줄 알았던 작업은 또다른 삽질기가 되었다.😭 Kubernetes에서 SNAT이 되는 과정을 이해하고 externalTrafficPolicy를 Local로 설정했다. 그리고 External Load balancer에서는 client IP를 전달하기 위해서 Proxy Protocol와 같은 것을 설정하고, Nginx에서 그 Proxy protocol로 전달된 IP address로 Access control을 할 수 있도록 설정하였다.'
---

## Nginx allow IP address

Kubernetes cluster에서 Nginx를 통해서 허용된 IP로만 접근 가능하게 구성하고 싶었다. Nginx의 [http_access_module](https://nginx.org/en/docs/http/ngx_http_access_module.html)를 사용해서 간단하게 IP allow list나 deny list를 셋팅할 수 있을 것이라 기대를 했다. 따라서 아래와 같이 Kubernetes object를 만들어서 테스트를 해보았다.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-clone-conf
data:
  nginx.conf: |
    user nginx;
    worker_processes  auto;
    error_log  /var/log/nginx/error.log;
    events {
      worker_connections  1024;
    }
    http {
      log_format  main
              'remote_addr:$remote_addr\t'
              'time_local:$time_local\t'
              'method:$request_method\t'
              'uri:$request_uri\t'
              'host:$host\t'
              'status:$status\t'
              'bytes_sent:$body_bytes_sent\t'
              'referer:$http_referer\t'
              'useragent:$http_user_agent\t'
              'forwardedfor:$http_x_forwarded_for\t'
              'request_time:$request_time';
      access_log /dev/stdout main;
      server {
        listen 80 default_server;
        location / {
          allow 40.150.119.175;
          deny all;
          proxy_pass http://example.com/;
          proxy_http_version 1.1;
        }
      }
    }
```

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-clone
spec:
  replicas: 1
  selector:
    matchLabels:
      app: nginx-clone
  template:
    metadata:
      labels:
        app: nginx-clone
    spec:
      containers:
        - name: nginx-clone
          image: nginx
          ports:
            - containerPort: 80
          volumeMounts:
            - mountPath: /etc/nginx
              readOnly: true
              name: nginx-conf
            - mountPath: /var/log/nginx
              name: log
      volumes:
        - name: nginx-conf
          configMap:
            name: nginx-clone-conf
            items:
              - key: nginx.conf
                path: nginx.conf
        - name: log
```

Naver Cloud의 Network Proxy Loadbalancer를 사용하기 위하여 아래처럼 annotation을 정의하였다. Network Proxy Load balancer에서 TLS termination을 하고, upstream에는 http로 접근을 하도록 설정하였다.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx-clone
  annotations:
    service.beta.kubernetes.io/ncloud-load-balancer-layer-type: nplb
    service.beta.kubernetes.io/ncloud-load-balancer-ssl-certificate-no: '8857'
    service.beta.kubernetes.io/ncloud-load-balancer-tls-ports: '443'
    service.beta.kubernetes.io/ncloud-load-balancer-tls-min-version: TLSV10
spec:
  type: LoadBalancer
  ports:
    - port: 443
      targetPort: 80
  selector:
    app: nginx-clone
```

하지만 `allow 40.150.119.175;` 정의된 것처럼 접속하는 client IP가 `40.150.119.175`인데, 403 response를 받았다. stdout으로 설정한 access log를 확인해보니 `$remote_addr`가 Kubernetes cluster 내부의 IP address로 찍혔다. (예 `192.18.7.140`, `192.18.0.55`) 고민해보니 Kubernetes에서는 kube-proxy가 SNAT을 하는 부분이 생길 수 있다라는 것이 생각났다. Node port나 Load Balancer type의 서비스에 접근할 때, Worker node의 port로 접근하게 된다. 그런데 접근하는 Worker node에 통신하려는 Pod가 있을 수도 있고 없을 수도 있다. 없는 경우에도 kube-proxy를 통해서 있는 Node 쪽으로 routing이 될 수 있다. 그리고 Iptable를 사용하는 경우에는 아래처럼 traffic을 random하게 분배해줄 수 있다. 그래서 pod가 여러 개 있을 때 kube-proxy를 통해서 load balancing도 된다. 그러는 과정에서 SNAT으로 client ip가 유실 된다.

```bash
sudo iptables -t nat -A OUTPUT -d 10.99.99.32 -j DNAT --to-destination 10.244.15.196
sudo iptables -t nat -A OUTPUT -p tcp -d 10.99.99.32 --dport 27017 -m statistic --mode random --probability 0.50000000000 -j DNAT --to-destination 10.244.14.195:8090
sudo iptables -t nat -A OUTPUT -p tcp -d 10.99.99.32 --dport 27017 -j DNAT --to-destination 10.244.14.196:8090
```

기본적으로 `service.spec.externalTrafficPolicy`는 Cluster로 설정이 되어 있다. 위에서 설명한 것처럼 작동이 된다. 네이버 클라우드에서는 CNI로 cilium을 쓰고 있는데, access log에 찍혔던 `192.18.7.140`, `192.18.0.55`는 cilium host ip였다. `kubectl describe node`를 보니 `io.cilium.network.ipv4-cilium-host` annotation이 붙어 있었고, 이 값이 log에 찍혔던 IP address였다.

그럼 이제 client ip를 유지하기 위해서 `service.spec.externalTrafficPolicy`를 Local로 변경하였다. 이제 Load balancer의 CIDR의 IP address가 access log에 찍히는 것을 확인할 수 있다. `Local`로 했을 때는 이제 연결된 Node내의 pod endpoint만 접속을 시도하고 없으면 packet이 drop된다. `Load balancer` type으로 서비스를 생성하고, Node가 세 개라고 한다고 하면 Load balancer의 Target으로 세 개의 Node가 붙을 것이다. 그런데 service의 endpoint가 하나만 존재한다고 하면(running중인 pod가 하나라면), 그 pod가 있는 Node은 health check를 성공하고 나머지 Node에서는 실패한다. Load balancer에서 healthy한 Node에만 traffic을 보내기 때문에, `Local`로 설정하여도 정상적으로 트래픽을 전달할 수가 있다.

하지만 아직도 문제가 있다. Load balancer의 IP address는 최초의 요청하는 client IP가 아니기 때문에 `allow 40.150.119.175;`를 만족하지 않는다. 동일하게 403 에러가 발생하게 된다.

## X-Forwared-For & Proxy Protocol

source ip를 전달하는 방법으로 Header에 `X-Forwarded-For`, `X-Real-IP`에 hop하는 Ip address를 담아서 보내는 것도 있고, L4에서 전달할 때 Proxy Protocol을 사용하여 전달할 수도 있다. 이제 네이버 클라우드 Load balancer에서도 proxy protocol를 지원하기 때문에 아래처럼 annotation을 추가하여 source ip를 전달하도록 한다.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx-clone
  annotations:
    service.beta.kubernetes.io/ncloud-load-balancer-proxy-protocol: 'true'
```

그리고 Nginx에서 Proxy protocol을 받을 수 있고, 그것을 access log에 보여 줄 수 있도록 수정한다. `$proxy_protocol_add`를 통해서 source ip를 보여줄 수 있고, proxy protocol을 accept할 수 있도록 `listen 80 proxy_protocol`로 정의를 해준다.

```bash
http {
  log_format  main
  'remote_addr:$remote_addr\t'
  'time_local:$time_local\t'
  'method:$request_method\t'
  'uri:$request_uri\t'
  'host:$host\t'
  'status:$status\t'
  'bytes_sent:$body_bytes_sent\t'
  'referer:$http_referer\t'
  'useragent:$http_user_agent\t'
  'forwardedfor:$http_x_forwarded_for\t'
  'proxy_addr:$proxy_protocol_addr\t'
  'request_time:$request_time';
  access_log /dev/stdout main;

  server {
    listen 80 proxy_protocol;
    location / {
    ...
```

이렇게 해주면 될 줄 알았지만, 여전히 403를 뱉어 내었다. 😭😭 `$proxy_protocol_addr`는 이제 client Ip가 찍혔지만, 여전히 `$remote_addr`는 Load balancer의 Ip가 찍혔다. 그래서 순간 Lua로 module을 만들어서 해당 정보를 뭔가 `$remote_addr`에 설정해줘야 하는건가 생각이 들었다.

## Nginx Ingress Controller

마침 `Nginx Ingress Controller`도 같이 테스트해보고 있는 상황이어서 `Nginx Ingress Controller`에서는 Proxy protocol로 보낸 client ip로 allow list 확인을 어떻게 하는지 찾아보기 시작했다. [Nginx Ingress Controller 깃헙의 이슈](https://github.com/kubernetes/ingress-nginx/issues/4305)에서 사무실 IP CIDR로 접근 제어가 되었다라는 이야기가 나왔다.

Nginx Ingress Controller의 Resource들을 만들때, ConfigMap에서 `use-proxy-protocol`을 `true`로 설정을 해줬다.

```yaml
apiVersion: v1
data:
  allow-snippet-annotations: 'true'
  use-proxy-protocol: 'true'
kind: ConfigMap
metadata:
  labels:
    app.kubernetes.io/component: controller
    app.kubernetes.io/instance: ingress-nginx
    app.kubernetes.io/name: ingress-nginx
    app.kubernetes.io/part-of: ingress-nginx
    app.kubernetes.io/version: 1.8.2
  name: ingress-nginx-controller
  namespace: ingress-nginx
```

그리고 Ingress는 아래와 같이 annotation을 추가하여 Ip allow list를 설정하였다.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: nginx-ingress
  annotations:
    kubernetes.io/ingress.class: 'nginx'
    nginx.ingress.kubernetes.io/whitelist-source-range: '40.150.119.175'
```

그리고 만들어진 Load balancer의 proxy protocol 설정을 enable해주고, 접속하니깐 이제 드디어 정상적으로 접속이 되었다. `whitelist-source-range`를 변경하니깐 이제 다시 403 에러를 리턴 받았다. 🙂

## Nginx.conf 확인

그래서 이제 이과정에서 만들어진 nginx pod에 접속하여 `nginx.conf` 값을 확인해보게 되었다. 처음에 Lua script를 사용하는게 보여서, Lua script를 사용하여 해결한 것인가 생각이 들었다. 하지만 쭉 살펴보다가 아래의 설정들을 보게 되었다.

```bash
real_ip_header      proxy_protocol;
real_ip_recursive   on;
```

뭔가 `아하!`하는 생각이 들었고, [Nginx http_realip_module](https://nginx.org/en/docs/http/ngx_http_realip_module.html)을 확인해보니 아래와 같이 설명이 되어 있었다.

> Defines the request header field whose value will be used to replace the client address.

이제 느낌이 와서 신나서 아래와 같이 추가했지만, 여전히 403 에러를 리턴했다. 😇

```bash
http {
  ...
  real_ip_header proxy_protocol;
```

좀더 `nginx.conf`를 보니 `set_real_ip_from`가 설정되어 있는 것을 확인할 수 있었다. 이제 아래처럼 설정하고 나니 정상적으로 allow list에 적용되어 데이터를 받아왔다. 그리고 `$remote_addr`에도 client ip가 찍히게 되었다. 😭😭

```bash
http {
  ...
  real_ip_header proxy_protocol;
  real_ip_recursive on;
  set_real_ip_from 0.0.0.0/0;
```

이제 `set_real_ip_from`은 load balancer가 internal하게 만들어지는 IP address를 알고 있으니깐, `0.0.0.0/0` 대신에 `10.200.5.0/24`처럼 넣어서 마무리를 했다.
