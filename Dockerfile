# Use the official Deno image
FROM denoland/deno:alpine-2.5.4

# Install curl and Node.js with npm (needed for hardhat compile)
# Use nodejs and npm packages from Alpine edge/community for latest versions
RUN apk add --no-cache curl nodejs npm --repository=http://dl-cdn.alpinelinux.org/alpine/edge/community

# Create app directory
RUN mkdir -p /app

# Set working directory
WORKDIR /app

# Copy your project files
COPY . .

# Compile hardhat contracts
RUN cd hardhat && npm ci && npx hardhat compile

CMD ["deno", "task", "start"]
