# 测试专用 TLS 证书

`cert.pem` 与 `key.pem` 是**仅用于测试**的自签证书，由 openssl 生成，`CN=localhost`、
SAN 含 `DNS:localhost,IP:127.0.0.1`，有效期至 2036-10-12。

**这不是机密材料**：它没有被任何生产服务使用，也不保护任何真实数据；任何人都可以重新生成一份等价物。
把它放进仓库是为了让 SMTP 测试在**没有 openssl 或生成步骤的环境**里也能跑真实 TLS 路径
（测试连接 `127.0.0.1` 上的 mock SMTP 服务器，不联网、不发真实邮件）。

重新生成：

```bash
cd chatbot/plugins/kurumi-mail/test/fixtures
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

测试通过显式传入 `ca`（`test/smtp.test.js`、`test/gate.test.js` 里的 `connectorTrustingTestCert`）来信任它，
**没有**全局放宽 TLS 校验（不使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`，也不设 `rejectUnauthorized:false`）。
