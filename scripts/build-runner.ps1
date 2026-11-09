# PowerShell script to build the In-Container Game Runner image
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Building NebulaStream Runner Docker Image" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

docker build -f docker/Dockerfile.runner -t nebulastream-runner:latest .

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nSuccessfully built nebulastream-runner:latest!" -ForegroundColor Green
    Write-Host "To test run with GPU passthrough:" -ForegroundColor Yellow
    Write-Host "docker run --rm -it --gpus all -p 8080:8080 nebulastream-runner:latest" -ForegroundColor White
} else {
    Write-Host "`nDocker build failed with exit code $LASTEXITCODE" -ForegroundColor Red
}

