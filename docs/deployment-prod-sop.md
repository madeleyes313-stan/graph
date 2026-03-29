# 生产部署准备说明

本文档只覆盖当前项目的第一步: 补齐部署资产并给出上线前准备清单。

## 当前部署形态

- `server`: Node/Express + SQLite，负责 API、抽取任务、文件上传、数据持久化
- `web`: React + Vite，构建后由 Nginx 提供静态资源，并反向代理 `/api`
- 默认对外端口为 `8080`

注意:
- 当前配置默认不直接占用 `80/443`
- 在远端完成端口与现网站点预检前，不要改成 `80/443`
- HTTPS 证书接入应在远端预检和子域名决策完成后再做

## 本地已补齐的部署资产

- `server/Dockerfile`
- `web/Dockerfile`
- `web/nginx.production.conf`
- `docker-compose.prod.yml`
- `.env.example`
- `server/.env.example`

## 部署前准备

### 1. 复制环境变量文件

在项目根目录:

```bash
cp .env.example .env
```

在 `server` 目录:

```bash
cp server/.env.example server/.env
```

### 2. 按实际情况填写配置

根目录 `.env`:

- `COMPOSE_PROJECT_NAME`
- `HOST_HTTP_PORT`

`server/.env`:

- `PORT`
- `EXTRACTION_TIMEOUT_MS`
- `AI_BASE_URL`
- `AI_API_KEY`
- `AI_MODEL`
- `DB_PATH`

建议:
- `HOST_HTTP_PORT=8080`
- `PORT=3001`
- `DB_PATH=data/fact-graph.sqlite`

## 本地/服务器启动命令

```bash
docker compose --env-file .env -f docker-compose.prod.yml up -d --build
```

停止:

```bash
docker compose --env-file .env -f docker-compose.prod.yml down
```

查看日志:

```bash
docker compose --env-file .env -f docker-compose.prod.yml logs -f
```

## 验收检查

启动后先验证:

1. 前端首页是否可打开
2. `GET /api/health` 是否返回正常
3. 案件切换、图谱加载、版本记录是否正常
4. 上传卷宗后是否能成功触发抽取
5. 新版本是否能生成并持久化

## 当前仍缺的上线前准备

这些事项还没有包含在本次本地适配里，后续上云前必须确认:

1. 腾讯云服务器接入信息
   - IP
   - 系统版本
   - SSH 用户名
   - SSH 端口
   - 认证方式
2. 子域名与 DNS 指向
3. HTTPS 证书获取与挂载方案
4. 远端端口、容器、现网站点预检
5. 是否需要访问控制
   - 建议至少加一层 Nginx Basic Auth 或 IP 白名单
6. 数据备份方案
   - SQLite 数据文件
   - 上传卷宗目录
7. 监控与告警
8. 定期清理与容量控制
   - `uploads`
   - SQLite 数据增长

## 生产化差距说明

当前配置适合第一批用户受控使用，但离严格生产标准仍有差距:

- 数据库仍为 SQLite，本地磁盘单机存储
- 没有对象存储
- 没有登录/鉴权体系
- 没有任务队列中间件
- 没有监控、告警、自动备份
- HTTPS 证书和正式域名接入尚未落地

如果后续要继续升级到更正式的生产形态，建议逐步补:

1. 子域名 + HTTPS
2. Basic Auth 或应用层登录
3. COS 存储上传文件
4. MySQL/PostgreSQL 替代 SQLite
5. 队列化抽取任务
6. 监控、日志、备份与回滚

