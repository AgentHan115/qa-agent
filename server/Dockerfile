FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Uploads directory must exist
RUN mkdir -p uploads

EXPOSE 5001

CMD ["node", "server.js"]
