# Stage 1: Compile hardhat contracts using Node
FROM node:20-alpine AS builder

WORKDIR /build
COPY hardhat/ ./
RUN npm ci && npx hardhat compile

# Stage 2: Run with Deno
FROM denoland/deno:alpine-2.5.4

# Install curl
RUN apk add --no-cache curl

# Create app directory
RUN mkdir -p /app

# Set working directory
WORKDIR /app

# Copy project files
COPY . .

# Copy compiled artifacts from builder
COPY --from=builder /build/artifacts ./hardhat/artifacts

CMD ["deno", "task", "start"]
