FROM node:20-alpine

WORKDIR /app

# Зависимости отдельно для кэширования слоёв
COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

EXPOSE 3001

CMD ["node", "src/index.js"]
