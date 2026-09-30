# ---- 构建阶段：编译 TypeScript ----
FROM docker.m.daocloud.io/library/node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 生产依赖：只保留运行时需要的包（devDependencies 不进最终镜像）----
FROM docker.m.daocloud.io/library/node:22-slim AS prod-deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- 运行阶段 ----
FROM docker.m.daocloud.io/library/node:22-slim AS runtime
WORKDIR /app

# 以下默认值都可以用 docker run -e 或 compose 的 environment 覆盖
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    BROWSER_CHANNEL=chromium-headless-shell \
    BROWSER_HEADLESS=true \
    BROWSER_NO_SANDBOX=true \
    BROWSER_IDLE_TIMEOUT_MS=60000 \
    MAX_CONCURRENCY=4 \
    CAPTURE_TIMEOUT_MS=30000

COPY package.json package-lock.json ./
COPY --from=prod-deps /app/node_modules ./node_modules

# 只装 chromium 的 headless shell（约 90MB，完整 chromium 要 170MB+），
# 本服务只跑无头模式，够用。
# --with-deps 装齐 Chromium 运行所需的系统库；版本号从已安装的 playwright-core 推导，
# 避免 npx 拉到更新的 playwright 导致浏览器 revision 不匹配（会启动失败）。
# 中文字体单独补：默认的 liberation/unifont 不含 CJK，中文页面会渲染成方块。
# 不需要中文时可删掉 apt-get 那两行。
RUN npx --yes playwright@$(node -p "require('playwright-core/package.json').version") \
        install --with-deps --only-shell chromium \
 && apt-get update \
 && apt-get install -y --no-install-recommends fonts-wqy-zenhei \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY --from=build /app/dist ./dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 以 root 运行 + --no-sandbox（BROWSER_NO_SANDBOX=true）是最省事的组合；
# 若要用非 root：改成 USER node 并把 BROWSER_NO_SANDBOX 设为 false。
CMD ["node", "dist/index.js"]
