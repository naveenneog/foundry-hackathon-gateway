# Key Dashboard image (P53, ADR-0015; first built for P46, ADR-0014). Built by
# scripts/Deploy-Console.ps1 with `az acr build` from a context that holds only src/keys.mjs,
# src/foundry.mjs, src/models.mjs, src/console/**, the product policy template and a minimal
# package.json: no dependencies, no tests, no repo history. Distroless: no shell, no package
# manager, non-root. The dashboard and the automation job run the same image.
FROM mcr.microsoft.com/azurelinux/distroless/nodejs:24-nonroot
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY poc/products-keyvault/infra/product-policy.xml ./poc/products-keyvault/infra/product-policy.xml
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER nonroot
ENTRYPOINT ["node"]
CMD ["src/console/main.mjs"]
