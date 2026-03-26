export class AppError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ScrapeError extends AppError {
  constructor(message, storeId, details = null) {
    super(message, 500, details);
    this.name = 'ScrapeError';
    this.storeId = storeId;
  }
}

export class AIAnalysisError extends AppError {
  constructor(message, taskType, details = null) {
    super(message, 502, details);
    this.name = 'AIAnalysisError';
    this.taskType = taskType;
  }
}

export class ValidationError extends AppError {
  constructor(message, fields = null) {
    super(message, 400, fields);
    this.name = 'ValidationError';
  }
}
