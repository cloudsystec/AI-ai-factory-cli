param(
  [Parameter(Mandatory = $true)]
  [string]$TenantId,
  [switch]$Build
)

if ($Build) {
  $RootBuild = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
  Write-Host "A construir imagem ai-factory-cli:latest..."
  docker build -t ai-factory-cli:latest $RootBuild
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvFile = Join-Path $Root "data\tenants\$TenantId\.env"
$Image = if ($env:AIFACTORY_CLI_IMAGE) { $env:AIFACTORY_CLI_IMAGE } else { "ai-factory-cli:latest" }

if (-not (Test-Path $EnvFile)) {
  Write-Error "Ficheiro $EnvFile não encontrado. No repo back: npm run pull-tenant-env -- $TenantId"
  exit 1
}

$Name = "aifactory-cli-$TenantId"
docker rm -f $Name 2>$null

$NetworkArg = @()
if ($env:AIFACTORY_DOCKER_NETWORK) {
  $NetworkArg = @("--network", $env:AIFACTORY_DOCKER_NETWORK)
}

docker run -d --name $Name `
  --env-file $EnvFile `
  -v "${Root}\data\tenants\${TenantId}:/app/data/tenants/${TenantId}" `
  --add-host=host.docker.internal:host-gateway `
  @NetworkArg `
  $Image

Write-Host "Worker $Name iniciado."
Write-Host "Redis no .env do tenant deve ser acessivel do container (ex.: redis://host.docker.internal:6379, nao 127.0.0.1)."
