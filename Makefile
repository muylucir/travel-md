.PHONY: agent frontend install-web install-agent lint test deploy-lambda update-lambda setup-gateway deploy-all

# Agent
install-agent:
	cd agent && pip install -e ".[dev]"

agent:
	cd agent && uvicorn src.local_server:app --host 0.0.0.0 --port 8080 --reload

# Frontend
install-web:
	cd web && npm install

frontend:
	cd web && npm run dev

# DynamoDB
create-table:
	aws dynamodb create-table \
		--table-name ota-planned-products \
		--attribute-definitions AttributeName=product_code,AttributeType=S \
		--key-schema AttributeName=product_code,KeyType=HASH \
		--billing-mode PAY_PER_REQUEST \
		--region ap-northeast-2

create-schema-table:
	aws dynamodb create-table \
		--table-name graph-schemas \
		--attribute-definitions AttributeName=schemaId,AttributeType=S \
		--key-schema AttributeName=schemaId,KeyType=HASH \
		--billing-mode PAY_PER_REQUEST \
		--region ap-northeast-2

delete-table:
	aws dynamodb delete-table \
		--table-name ota-planned-products \
		--region ap-northeast-2

delete-schema-table:
	aws dynamodb delete-table \
		--table-name graph-schemas \
		--region ap-northeast-2

# Lambda + Gateway
deploy-lambda:
	./infra/scripts/deploy_lambda.sh create

update-lambda:
	./infra/scripts/deploy_lambda.sh update

setup-gateway:
	./infra/scripts/setup_gateway.sh

deploy-all: deploy-lambda setup-gateway

# Quality
lint:
	cd agent && ruff check src/
	cd web && npm run lint

test:
	cd agent && pytest tests/ -v
	cd web && npm test
