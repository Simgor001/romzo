FROM --platform=$BUILDPLATFORM golang:1.26.1-alpine AS build
ARG TARGETOS
ARG TARGETARCH
RUN apk add --no-cache ca-certificates
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY LICENSE ./LICENSE
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /relay .
RUN mkdir -p /licenses && cp LICENSE /licenses/romzo-LICENSE && cp /usr/local/go/LICENSE /licenses/go-LICENSE && cp /usr/local/go/PATENTS /licenses/go-PATENTS && \
    go list -deps -f '{{if .Module}}{{.Module.Path}} {{.Module.Version}}{{end}}' . | sort -u > /licenses/THIRD_PARTY_MODULES.txt
RUN go list -deps -f '{{if .Module}}{{.Module.Dir}}{{end}}' . | sort -u | while read -r dir; do \
    if [ -n "$dir" ]; then for notice in "$dir"/LICENSE* "$dir"/COPYING* "$dir"/NOTICE*; do \
    if [ -f "$notice" ]; then cp "$notice" "/licenses/$(basename "$dir")-$(basename "$notice")"; fi; done; fi; done
FROM scratch
COPY --from=build /relay /relay
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /licenses /licenses
USER 65532:65532
EXPOSE 9224
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["/relay", "-health"]
ENTRYPOINT ["/relay"]
