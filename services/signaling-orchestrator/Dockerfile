FROM node:20-alpine

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm install

# Copy source code and config
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript
RUN npm run build

EXPOSE 8080

CMD ["npm", "start"]

