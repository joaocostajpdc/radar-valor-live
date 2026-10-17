FROM oven/bun:1
WORKDIR /app
COPY index.tsx .
ENV PORT=10000
EXPOSE 10000
CMD ["bun", "index.tsx"]
