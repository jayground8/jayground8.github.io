---
title: ''
date: '2025-07-26'
tags: ['openvpn', 'oauth2']
images: ['/static/images/thumbnail/openvpn-oidc.png']
summary: ''
---

When you have many internal tools that require login, managing users and roles individually across separate systems can become a real headache. Fortunately, there’s an excellent open-source project called Keycloak. I prefer to integrate all internal tools with Keycloak to centralize authentication and authorization management. That’s why I also wanted to integrate OpenVPN with Keycloak.

There are two main editions of OpenVPN: the open-source Community Edition, and the enterprise-grade OpenVPN Access Server. Naturally, the enterprise edition offers robust features and can significantly reduce the effort needed to run a secure VPN server. It likely includes built-in support for integrating with Keycloak, making it a convenient choice.

If you’re deploying a self-hosted VPN server in a corporate environment, the enterprise edition can be a smarter decision—it saves time, allowing you to focus on tasks that contribute directly to your business’s core value. However, if you don’t need any advanced features, running the Community Edition on your server is a perfectly reasonable option.

Setting up a self-hosted VPN and integrating it with Keycloak wasn’t an urgent or critical task for me. Out of curiosity, I began exploring whether the OpenVPN Community Edition could meet my requirements during my spare time. Honestly, if this had been a necessity at a company, I would have chosen the enterprise edition to save time and effort—well worth the cost.

## Authentication

One of my requirements was to integrate Keycloak for authentication. Thanks to two great open-source projects, I was able to understand how OpenVPN can support authentication via the OAuth2 protocol:

- An example using Python(https://github.com/thesparklabs/openvpn-okta-sso-example)
- An example using Go(https://github.com/jkroepke/openvpn-auth-oauth2)

Let me explain how this works. You should think of it in two parts: the client side and the server side.

On the client side, there’s OpenVPN Connect, which is the client application used to access the VPN server. When you try to connect to the OpenVPN server using OpenVPN Connect, the server requests that you authenticate via OAuth2 (in our case, through Keycloak). OpenVPN Connect then opens the Keycloak login page in your browser. You enter your Keycloak username and password, and upon successful login, you’re authenticated and the VPN connection is established.

### A More Detailed Step-by-Step Explanation

Here’s a more detailed breakdown of what happens:

1. OpenVPN Connect receives a message from the server that includes a URL for the login page. For example, the server might send:

```sh
client-pending-auth 1 1 WEB_AUTH::http://localhost:3000/login?state=16dd5a57b23e2d51 120
```

2. This tells OpenVPN Connect to open http://localhost:3000/login in your browser.
3. You can see this process in action by checking the OpenVPN Connect logs. It first logs an AUTH_PENDING event, followed by the WEB_AUTH event, which includes the URL that the browser should open.

<img src="/static/images/openvpn-connect-log.png" alt="openvpn connect logs" />

4. Once you see the Keycloak login page in your browser, you enter your credentials. After a successful login, Keycloak redirects to a callback URL you configured in your Keycloak client using OIDC.

Now you might ask: “Callback to where?”

Good question. This callback doesn’t go to the OpenVPN server directly. Instead, you need to run a separate server—let’s call it the Node.js server—to handle the callback from Keycloak. Later, I’ll share some Node.js code to make this clearer.

The Node.js server receives the callback from Keycloak, verifies the authentication result, and determines whether the user should be allowed to connect to the OpenVPN server.

At this point, you should understand that your system has two servers running:

- The OpenVPN server
- The Node.js server (handling the OAuth2 flow)

The client is trying to connect to the OpenVPN server, but the authentication result is handled by the Node.js server. So how do you let the OpenVPN server know that the user has been successfully authenticated?

This is where the OpenVPN Management Interface comes into play.

Once the Node.js server confirms that the user has successfully authenticated via OIDC, it uses the management interface to notify the OpenVPN server, which then allows the VPN connection to proceed. The Node.js server and the OpenVPN server exchange messages through this management interface using a simple protocol.

> The OpenVPN Management interface allows OpenVPN to be administratively controlled from an external program via a TCP or unix domain socket.

---

Let's what message get exchanged between Nodejs server and OpenVPN server throughout newly established connection.

1. OpenVPN Server → Node.js Server:\
   “Hey Node.js! A client is trying to establish a new connection.”\
   `>CLIENT:CONNECT,0,1`\

2. Node.js Server → OpenVPN Server:\
   “Oh really? Could you ask the client to authenticate using this URL?”\
   `client-pending-auth 0 1 WEB_AUTH::http://localhost:3000/login?state=16dd5a57b23e2d51 120`\

3. Node.js Server → OpenVPN Server:\
   “I received a valid callback request from Keycloak. The user is authenticated. You can proceed with the connection.”\
   `client-auth 0 1`

4. OpenVPN Server → Node.js Server:\
   “The connection has been successfully established. Thank you for your cooperation!”\
   `>CLIENT:ESTABLISHED,0`
