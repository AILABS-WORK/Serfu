# Use Node 22 slim image
FROM node:22-slim

# Install system dependencies required for canvas and other native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (for better layer caching)
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
# npm ci is faster and more reliable for builds
RUN npm ci --only=production=false

# Copy source code (docs, tests, scripts excluded via .dockerignore)
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Start the application
CMD ["npm", "run", "start"]

