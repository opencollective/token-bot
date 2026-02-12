# Use the official Deno image
FROM denoland/deno:alpine-2.5.4

# Install curl
RUN apk add --no-cache curl

# Create app directory
RUN mkdir -p /app

# Set working directory
WORKDIR /app

# Copy your project files (includes pre-compiled hardhat/artifacts)
COPY . .

CMD ["deno", "task", "start"]
