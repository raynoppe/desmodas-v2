import pool from '../../db/postgres.js';
import { logger } from '../../lib/logger.js';

class TrainingDataset {
  async save(taskType, inputData, aiOutput, modelUsed = 'claude-sonnet-4-5') {
    try {
      await pool.query(
        `INSERT INTO ai_training_data (task_type, input_data, ai_output, model_used)
         VALUES ($1, $2, $3, $4)`,
        [taskType, JSON.stringify(inputData), JSON.stringify(aiOutput), modelUsed]
      );
    } catch (error) {
      // Non-critical: don't let training data failures break the pipeline
      logger.warn({ error: error.message, taskType }, 'Training data save error');
    }
  }
}

export const trainingDataset = new TrainingDataset();
