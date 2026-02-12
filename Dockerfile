# Use the official Deno image
FROM denoland/deno:alpine-2.5.4

# Install curl and Node.js (needed for hardhat compile)
RUN apk add --no-cache curl nodejs npm

# Create app directory
RUN mkdir -p /app

# Set working directory
WORKDIR /app

# Copy your project files
COPY . .

# Compile hardhat contracts
RUN cd hardhat && npm ci && npx hardhat compile

CMD ["deno", "task", "start"]
