FROM python:3.13-slim

WORKDIR /app

# 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    # 中文字体
    fonts-noto-cjk \
    fonts-wqy-zenhei \
    # Google Chrome for Remotion
    && curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

# Node.js (for Remotion CLI)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Python 代码
COPY backend/ .

# Remotion 项目 + 依赖
COPY backend/remotion/ ./remotion/
RUN cd remotion && npm install

# Playwright 浏览器
RUN playwright install chromium
RUN playwright install-deps

# Remotion Chrome 路径
ENV REMOTION_CHROME_PATH=/usr/bin/google-chrome

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
