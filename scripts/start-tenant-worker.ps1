param(
  [Parameter(Mandatory = $true)]
  [string]$TenantId
)

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvFile = Join-Path $Root "data\tenants\$TenantId\.env"
$Image = if ($env:AIFACTORY_CLI_IMAGE) { $env:AIFACTORY_CLI_IMAGE } else { "ai-factory-cli:latest" }

if (-not (Test-Path $EnvFile)) {
  Write-Error "Ficheiro $EnvFile não encontrado. No repo back: npm run pull-tenant-env -- $TenantId"
  exit 1
}

$Name = "aifactory-cli-$TenantId"
docker rm -f $Name 2>$null

docker run -d --name $Name `
  --env-file $EnvFile `
  -v "${Root}\data\tenants\${TenantId}:/app/data/tenants/${TenantId}" `
  --add-host=host.docker.internal:host-gateway `
  $Image

Write-Host "Worker $Name iniciado."
