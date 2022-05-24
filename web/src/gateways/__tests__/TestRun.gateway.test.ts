import {endpoints} from '../../redux/apis/TraceTest.api';
import TestRunResultGateway from '../TestRun.gateway';

const {getRunList, getRunById, reRun} = endpoints;

jest.mock('../../redux/apis/Test.api', () => {
  const initiate = jest.fn(() => Promise.resolve());

  return {
    endpoints: {
      getRunList: {initiate},
      getRunById: {initiate},
      reRun: {initiate},
    },
  };
});

describe('TestRunGateway', () => {
  it('should execute the get function', async () => {
    expect.assertions(1);
    await TestRunResultGateway.get('testId');

    expect(getRunList.initiate).toBeCalledWith({testId: 'testId', take: 25, skip: 0});
  });

  it('should execute the getById function', async () => {
    expect.assertions(1);
    await TestRunResultGateway.getById('testId', 'resultId');

    expect(getRunById.initiate).toBeCalledWith({testId: 'testId', resultId: 'resultId'});
  });

  it('should execute the update function', async () => {
    expect.assertions(1);
    await TestRunResultGateway.reRun('testId', 'resultId');

    expect(reRun.initiate).toBeCalledWith({
      testId: 'testId',
      resultId: 'resultId',
    });
  });
});