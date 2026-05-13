FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
COPY .flue/ .flue/
COPY .agents/ .agents/
RUN npm run build
RUN npm run flue:build

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && apt-get purge -y python3 make g++ && apt-get autoremove -y
COPY --from=build /app/dist dist/
COPY --from=build /app/.flue-dist .flue-dist/
COPY .agents/ .agents/
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/start.js"]
