# 安全

English: [SECURITY.md](SECURITY.md)

不要提交部署用 .env 文件、口令、Turnstile 密钥、私钥、恢复/admission 票据、抓包或应用数据。用 `relay init` 在本地生成部署密钥并置于 Git 之外；.env.example 只含空的密钥占位。轮换口令还需更换 AUTH_SALT；轮换 TICKET_KEY 会使既有恢复票据失效。

`npm run check:public` 扫描每个被跟踪的文件与每个可达 Git 历史 blob，检查可疑凭据字面量、服务商 token 模式、私钥 PEM、本机路径与符号链接条目。提交身份必须使用 GitHub noreply 邮箱。具名、有文档说明的测试夹具可豁免凭据字面量规则；服务商 token/PEM 规则对测试同样生效。`npm run check:artifacts` 还检查生成的 SDK 输出与服务端二进制/声明。

扫描全净不代表没有密钥。发布前审查暂存 diff。SDK 打包使用 files 白名单，不含测试。

协议向量包含具名口令 public-test-vector-password、重复的测试盐与 RFC 8032 测试种子。测试生成临时密钥与票据。SDK 门面测试同样使用具名 vector-password 夹具。这些均为公开测试材料，不得用作部署凭据。集成测试在内存中生成服务端密钥，从不打印。

不要把敏感发现或凭据贴进公开 issue；启用时使用 GitHub 私密漏洞上报，没有私密渠道就先私下请求联系方式。

中继不建立用户身份，消息也不做持久化存储。签名 descriptor 只证明持有所声明的主机密钥，邀请是否可信需另行确认。源站（origin）检查不认证用户。公网部署需要严格的资源上限、TLS、显式可信代理 IP 与合适的建房策略；多实例路由目前不支持。
