import type {Customer} from '@/types';

export const normalizePhone = (value: string): string => value.replace(/[^0-9]/g, '');
export const normalizeDocument = (value: string): string => value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

export function customerMatches(customers: Customer[], phone: string, document: string): Customer[] {
  const phoneKey = normalizePhone(phone);
  const documentKey = normalizeDocument(document);
  return customers.filter(customer => [customer, ...(customer.aliases ?? [])].some(contact =>
    (phoneKey !== '' && normalizePhone(contact.phone) === phoneKey) ||
    (documentKey !== '' && normalizeDocument(contact.document) === documentKey)
  ));
}

export function searchCustomers(customers: Customer[], query: string): Customer[] {
  const text = query.trim().toLocaleLowerCase();
  const digits = normalizePhone(text);
  const document = normalizeDocument(text);
  return customers.filter(customer => [customer, ...(customer.aliases ?? [])].some(contact =>
    contact.name.toLocaleLowerCase().includes(text) ||
    (digits !== '' && normalizePhone(contact.phone).includes(digits)) ||
    (document !== '' && normalizeDocument(contact.document).includes(document))
  ));
}
