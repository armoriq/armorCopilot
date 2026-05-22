FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock
COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@5.6.0
RUN npx tsc -p tsconfig.json

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-package-lock
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
