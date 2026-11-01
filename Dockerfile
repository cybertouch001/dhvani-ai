# Dhvani AI backend — runs anywhere Docker runs: Hugging Face Space (Docker SDK), a GPU server, or your own VPS.
#   CPU (default):   docker build -t dhvani .
#   GPU (CUDA 12.8): docker build --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu128 -t dhvani .
#   run:             docker run -p 7860:7860 -e DHVANI_APP_PASSWORD=... -v dhvani-data:/data dhvani   (add --gpus all on GPU)
FROM python:3.11-slim
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 user
RUN pip install --no-cache-dir torch==2.8.0 torchaudio==2.8.0 --index-url ${TORCH_INDEX}
COPY server/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY server/app.py /app/app.py
RUN mkdir -p /data /app/private && chown -R user /data /app
USER user
ENV HOME=/home/user HF_HOME=/home/user/.cache/huggingface \
    DHVANI_DATA=/data DHVANI_PRIVATE=/app/private DHVANI_MODEL=k2-fsa/OmniVoice PYTHONUNBUFFERED=1
# fetch the model weights at build time so the first start is quick
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('k2-fsa/OmniVoice')"
WORKDIR /app
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "1"]
