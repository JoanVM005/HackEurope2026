from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.db.supabase_client import (
    ConflictError,
    NotFoundError,
    SupabaseRepository,
    UpstreamServiceError,
    ValidationError,
    get_repository,
)
from app.models.schemas import TaskDefinitionCreate, TaskDefinitionResponse, TaskDefinitionUpdate

router = APIRouter(tags=["task-definitions"])


@router.post(
    "/task-definitions",
    response_model=TaskDefinitionResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_task_definition(
    payload: TaskDefinitionCreate,
    repository: SupabaseRepository = Depends(get_repository),
) -> TaskDefinitionResponse:
    try:
        return repository.create_task_definition(payload)
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/task-definitions", response_model=list[TaskDefinitionResponse])
def list_task_definitions(
    repository: SupabaseRepository = Depends(get_repository),
) -> list[TaskDefinitionResponse]:
    try:
        return repository.list_task_definitions()
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/task-definitions/{task_definition_id}", response_model=TaskDefinitionResponse)
def get_task_definition(
    task_definition_id: UUID,
    repository: SupabaseRepository = Depends(get_repository),
) -> TaskDefinitionResponse:
    try:
        return repository.get_task_definition(task_definition_id)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.put("/task-definitions/{task_definition_id}", response_model=TaskDefinitionResponse)
def update_task_definition(
    task_definition_id: UUID,
    payload: TaskDefinitionUpdate,
    repository: SupabaseRepository = Depends(get_repository),
) -> TaskDefinitionResponse:
    try:
        return repository.update_task_definition(task_definition_id, payload)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.delete("/task-definitions/{task_definition_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task_definition(
    task_definition_id: UUID,
    repository: SupabaseRepository = Depends(get_repository),
) -> None:
    try:
        repository.delete_task_definition(task_definition_id)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
