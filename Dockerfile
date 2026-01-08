FROM node:18-bullseye

# Install Java & tools
RUN apt update && apt install -y openjdk-17-jdk wget unzip zip curl git lib32stdc++6 lib32z1 && rm -rf /var/lib/apt/lists/*

# Android SDK root
ENV ANDROID_SDK_ROOT=/opt/android-sdk
RUN mkdir -p $ANDROID_SDK_ROOT/cmdline-tools

# Download command-line tools
RUN wget https://dl.google.com/android/repository/commandlinetools-linux-9477386_latest.zip -O /tmp/cmdline-tools.zip \
 && unzip /tmp/cmdline-tools.zip -d /tmp/cmdline-tools \
 && mkdir -p $ANDROID_SDK_ROOT/cmdline-tools/latest \
 && mv /tmp/cmdline-tools/cmdline-tools/* $ANDROID_SDK_ROOT/cmdline-tools/latest/

# Add SDK tools & build-tools to PATH
ENV PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/build-tools/34.0.0

# Accept licenses & install build-tools
RUN yes | sdkmanager --licenses
RUN sdkmanager "build-tools;34.0.0"

# App working directory
WORKDIR /app

# Copy project
COPY . .

# Install Node.js dependencies
RUN npm install

# Ensure directories
RUN mkdir -p uploads uploads_tmp output keys \
 && chmod -R 777 uploads uploads_tmp output keys

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
