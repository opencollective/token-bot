# Stage 1: Compile hardhat contracts using Node
FROM node:20-alpine AS builder

# Install git (needed for github: dependencies in package.json)
RUN apk add --no-cache git

WORKDIR /build
COPY hardhat/ ./

# Install dependencies and compile
RUN npm install && npx hardhat compile

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
