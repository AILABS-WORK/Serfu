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

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
# npm ci is faster and more reliable for builds
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Start the application
CMD ["npm", "run", "start"]

