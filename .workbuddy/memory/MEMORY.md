# CursorPool 项目约定

## 用户环境
- 用户本地代理端口（如 7897）属于个人环境配置，**不能在项目代码中写死或硬编码依赖**
- 不假设用户一定启动了本地代理

## 日志路径
- Runner 日志：`~/.cursorpool/relay/runner.log`（primary）和 `AppData/Local/CursorPool/relay/runner.log`（mirror）
- 不要在项目目录写冗余日志副本
