# Contributing

欢迎提交 Issue 和 PR。

## 提交 PR

1. Fork 仓库并从 main 开分支。
2. 保持改动小而聚焦；不要顺手重构无关代码。
3. 更新 ghost.json 的 version 和 releaseNotes，说明相对已上架版本的变化。
4. 运行 node --check main.js 和 node --check node/worker.cjs。
5. 在 PR 描述里写清楚场景、改动和验证方式（直连、group/task-auto、额度耗尽、多账号等）。

## 安全

- 不要提交 token、~/.config/magpie/gateways.json、认证头或含凭证的日志。
- 远程 Magpie 网关应放在认证代理后，不要把 3425 直接暴露到公网。
- 新增文件或权限前先说明为什么现有实现不能完成同样的事。

## 许可证

提交即表示同意以 MIT 许可证发布贡献。
